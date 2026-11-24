/**
 * Ahoy launcher — the display the window is on: how large it really is, whether it is the PC's own panel, and how the
 * launcher's window fits on it.
 *
 * Windows' scale says little of a small screen: a 7 inch panel of 1920 × 1080 is set to 150% as often as to 100% or 200%, so
 * the page cannot tell a handheld from a laptop by the points it is given. The monitor itself says how large it is (its EDID,
 * read from Windows' WMI by main.ts), and Windows says how it is connected: a panel under about ten inches that is built
 * into the PC is held in the hands, whatever the scale, and the same PC in its dock on a television is not.
 *
 * No imports: main.ts uses this, the setup page's own script too (setup-pad.ts, bundled for the page), and the tests run it
 * as it is.
 */

/** one monitor that is on, as Windows tells of it (root\wmi: WmiMonitorBasicDisplayParams, WmiMonitorConnectionParams, WmiMonitorID) */
export interface Monitor {
  instance: string;
  /** the name the monitor gives itself ("" when it gives none: a built-in panel often does not) */
  name: string;
  /** its picture's size in centimetres, as its EDID says (0: it does not say; a projector, a capture box) */
  widthCm: number; heightCm: number;
  /** is it wired inside the PC? null: Windows did not say how it is connected */
  internal: boolean | null;
}
export interface Mm { width: number; height: number }

/** what the launcher tells a page of the display its window is on (preload: display(), and the event "display") */
export interface DisplayInfo {
  /** built into the PC (a laptop's or a handheld's own panel); false: plugged in; null: not known */
  internal: boolean | null;
  /** its picture's real size in millimetres (to the centimetre: that is all a monitor says), and its diagonal in inches */
  mm: Mm | null;
  inches: number | null;
  /** the diagonal of the PC's own built-in panel, whichever display the window is on (a handheld in its dock still is one) */
  panel: number | null;
  /** the display in Windows' own scaled points, and that scale */
  points: { width: number; height: number };
  scale: number;
}

/** what Electron says of a display (screen.getDisplayMatching) */
export interface ScreenLike { internal?: boolean; label?: string; size: { width: number; height: number }; scaleFactor?: number }

/** how a monitor is wired inside a PC (D3DKMDT_VIDEO_OUTPUT_TECHNOLOGY): internal, LVDS, embedded DisplayPort, embedded UDI */
const INTERNAL_LINKS = /* @__PURE__ */ new Set([0x80000000, 6, 11, 13]);

/**
 * The PowerShell that asks Windows for its monitors: one line of JSON, { size, link, name }, each a list keyed by the
 * monitor's instance name. Single quotes only (it travels as one argument). Read with parseMonitors.
 */
export const MONITOR_QUERY = /* @__PURE__ */ [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
  "$s = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorBasicDisplayParams | ForEach-Object { @{ i = $_.InstanceName; a = $_.Active; w = $_.MaxHorizontalImageSize; h = $_.MaxVerticalImageSize } })",
  "$l = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorConnectionParams | ForEach-Object { @{ i = $_.InstanceName; t = $_.VideoOutputTechnology } })",
  "$n = @(Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | ForEach-Object { @{ i = $_.InstanceName; n = (-join ($_.UserFriendlyName | Where-Object { $_ } | ForEach-Object { [char]$_ })) } })",
  "ConvertTo-Json -Compress -Depth 3 @{ size = $s; link = $l; name = $n }",
].join("; ");

const list = (x: unknown): Record<string, unknown>[] => (Array.isArray(x) ? x : x && typeof x === "object" ? [x] : []).filter((r): r is Record<string, unknown> => !!r && typeof r === "object");
const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : typeof x === "string" && x.trim() !== "" && Number.isFinite(Number(x)) ? Number(x) : NaN);

/** the monitors that are on, from what MONITOR_QUERY printed; null when that is not an answer (the read failed) */
export function parseMonitors(text: string): Monitor[] | null {
  let j: unknown;
  // (whatever a profile or a policy printed before the answer is passed over: the answer is the last line that is JSON)
  const line = String(text ?? "").split(/\r?\n/).map(l => l.trim()).filter(l => l.startsWith("{")).pop();
  if (!line) return null;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object") return null;
  const { size, link, name } = j as Record<string, unknown>;
  const links = new Map(list(link).map(r => [String(r.i ?? ""), num(r.t)]));
  const names = new Map(list(name).map(r => [String(r.i ?? ""), String(r.n ?? "").trim()]));
  const out: Monitor[] = [];
  for (const r of list(size)) {
    const instance = String(r.i ?? "");
    if (!instance || r.a === false) continue;
    const w = num(r.w), h = num(r.h), t = links.get(instance);
    out.push({
      instance, name: names.get(instance) ?? "",
      widthCm: w > 0 ? w : 0, heightCm: h > 0 ? h : 0,
      // (a 32 bit number with its top bit set may arrive as a negative one)
      internal: t == null || Number.isNaN(t) ? null : INTERNAL_LINKS.has(t < 0 ? t + 0x100000000 : t),
    });
  }
  return out;
}

const sameMonitor = (a: Monitor, b: Monitor) => a.widthCm === b.widthCm && a.heightCm === b.heightCm && a.internal === b.internal;

/**
 * Which of the monitors is this display? The only one that is on; the only built-in one, for a display Electron calls
 * built in; the one of its name (several of one model are the same size, so any of them); or the one left when every other
 * display has taken the monitor of its name. Null when none of that settles it: no size is better than another monitor's.
 */
export function monitorOf(d: Pick<ScreenLike, "internal" | "label">, monitors: readonly Monitor[], others: readonly string[] = []): Monitor | null {
  if (monitors.length === 1) return monitors[0]!;
  const inner = monitors.filter(m => m.internal === true);
  if (d.internal && inner.length === 1) return inner[0]!;
  const label = (d.label ?? "").trim();
  const named = label ? monitors.filter(m => m.name === label) : [];
  if (named.length) return named.every(m => sameMonitor(m, named[0]!)) ? named[0]! : null;
  const left = monitors.filter(m => !(m.name && others.includes(m.name)));
  return left.length === 1 ? left[0]! : null;
}

const mmOf = (m: Monitor | null | undefined): Mm | null => (m && m.widthCm > 0 && m.heightCm > 0 ? { width: m.widthCm * 10, height: m.heightCm * 10 } : null);
/** a picture's diagonal in inches, to a tenth */
export const inchesOf = (mm: Mm | null | undefined): number | null => (mm && mm.width > 0 && mm.height > 0 ? Math.round(Math.hypot(mm.width, mm.height) / 2.54) / 10 : null);

/**
 * What a page is told of the display. `monitors`: what Windows said (null: not read, or it could not be); `others`: the
 * names of the PC's other displays; `known`: the built-in panel's size as an earlier run read it.
 *
 * Built in when Electron says so or Windows says so of the monitor's connection (Electron takes only one kind of internal
 * connection for one). Plugged in only when both say so: Windows was read, and the display's monitor is wired outside, or no
 * monitor that is on is wired inside. Otherwise it is not known, and the page falls back on what it can see itself.
 */
export function displayInfo(d: ScreenLike, monitors: readonly Monitor[] | null, others: readonly string[] = [], known: Mm | null = null): DisplayInfo {
  const m = monitors ? monitorOf(d, monitors, others) : null;
  const internal = d.internal === true || m?.internal === true ? true
    : monitors && monitors.length > 0 && (m ? m.internal === false : monitors.every(x => x.internal === false)) ? false
    : null;
  const inner = (monitors ?? []).filter(x => x.internal === true);
  // the PC's own panel: the one monitor wired inside (when the window is on it, this display's); else as it was read before
  const panel = mmOf(inner.length === 1 ? inner[0] : null) ?? (internal === true ? mmOf(m) : null) ?? known;
  const mm = mmOf(m) ?? (internal === true ? panel : null);
  const w = Number(d.size?.width), h = Number(d.size?.height), s = Number(d.scaleFactor);
  return {
    internal, mm, inches: inchesOf(mm), panel: inchesOf(panel),
    points: { width: w > 0 ? Math.round(w) : 0, height: h > 0 ? Math.round(h) : 0 },
    scale: s > 0 ? s : 1,
  };
}
/** the built-in panel's size, to keep for the next start (null: this answer does not hold one) */
export function panelOf(d: ScreenLike, monitors: readonly Monitor[] | null, others: readonly string[] = []): Mm | null {
  if (!monitors) return null;
  const inner = monitors.filter(x => x.internal === true);
  if (inner.length === 1) return mmOf(inner[0]);
  const m = monitorOf(d, monitors, others);
  return d.internal === true && !inner.length ? mmOf(m) : null;
}

/* ─────────── a screen held in the hands ─────────── */

/** under this diagonal a built-in panel is held in the hands (handhelds are 7 to 8.8 inches; the smallest laptops 10.1,
 *  which a monitor that rounds its size down to whole centimetres gives as 9.7) */
export const HAND_INCHES = 9.5;
/** the tallest such a display is in Windows' points, where its size is not known (the rule the page itself has: big/mode.ts) */
export const HAND_POINTS = 800;
/** is the window on a screen held in the hands? By its real size when the monitor said it; else a PC with a touch screen
 *  and a short display that is not known to be plugged in */
export function inHands(d: Pick<DisplayInfo, "internal" | "inches" | "points">, touch: boolean): boolean {
  if (d.internal === false) return false;
  if (d.internal === true && d.inches != null && d.inches > 0) return d.inches < HAND_INCHES;
  return touch && d.points.height > 0 && d.points.height <= HAND_POINTS;
}

/* ─────────── the window ─────────── */

/** the launcher's window, and the smallest it goes, where a display has the room */
export const WINDOW = { width: 1360, height: 860, minWidth: 980, minHeight: 640 } as const;
export const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
/** a zoom the page may have: between a half and four times (anything that is no number: its own size) */
export const zoomOf = (factor: unknown): number => { const f = Number(factor); return Number.isFinite(f) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, f)) : 1; };

/**
 * The window and its smallest size, kept inside a display's work area (the display without the taskbar, in points). A small
 * panel at a high scale has less room than the window's usual minimum: 1920 × 1080 at 175% is 1097 × 617 points, at 200%
 * 960 × 540, and a window that may not be smaller than 980 × 640 is taller than that screen.
 */
export function windowFit(area: { width: number; height: number } | null | undefined): { width: number; height: number; minWidth: number; minHeight: number } {
  const w = area && area.width > 0 ? Math.floor(area.width) : Infinity, h = area && area.height > 0 ? Math.floor(area.height) : Infinity;
  return { width: Math.min(WINDOW.width, w), height: Math.min(WINDOW.height, h), minWidth: Math.min(WINDOW.minWidth, w), minHeight: Math.min(WINDOW.minHeight, h) };
}
export interface Rect { x: number; y: number; width: number; height: number }
/** a window's place put back inside a work area: no larger than it, no smaller than the minimum there, and wholly on it */
export function boundsInside(b: Rect, area: Rect): Rect {
  const fit = windowFit(area);
  const width = Math.min(Math.max(b.width, fit.minWidth), Math.floor(area.width)), height = Math.min(Math.max(b.height, fit.minHeight), Math.floor(area.height));
  const x = Math.min(Math.max(b.x, area.x), area.x + area.width - width), y = Math.min(Math.max(b.y, area.y), area.y + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width, height };
}
