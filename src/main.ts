/**
 * Ahoy launcher — Electron main process, the PC client for an Ahoy server on the network.
 *
 * The window shows the server's own web UI (always current, no second frontend build); this process adds
 * what a browser cannot do: install packages onto disk, verify them, run prerequisites, create shortcuts,
 * launch games. The renderer reaches it through the preload bridge (window.ahoyLauncher). The page signs
 * the person in; the launcher keeps the session token so its own downloads are signed in too.
 *
 * IPC the page may call (preload.ts names them):
 *   config:get · config:probe {serverUrl} · config:set {serverUrl?, libraryDir?, desktopShortcuts?} · config:pickDir
 *   session:set {token, user} | null · session:get · state · installed
 *   install (packageId) · install:cancel (packageId) · uninstall (slug, {deleteSaves?}) · play (slug) · openFolder (slug)
 *   window:fullscreen (on) · window:isFullscreen · window:zoom (factor) · display:get · big:take · update:state · update:check · update:install
 *   notify {title, body?, route?} · disk
 *   saves:state (slug, key, rules) · saves:push (slug, key, rules) · saves:pull (slug, key, rules, id) ·
 *   saves:agree (slug, key, rules, {id, digest}) · saves:pick (slug)
 *
 * Saves in step with the server (saves.ts, savesync.ts; the setting syncSaves): the server's page says which game, where it
 * keeps its saves (rules) and what to do; the launcher looks, packs and puts back, inside the places the rules may name and
 * nowhere else, with its own session, to its own server. Nothing is put back under a game that runs or is being installed.
 *
 * Without its window (settings background, startWithWindows): closing the window leaves Ahoy running by the clock (a tray
 * icon: Open, Quit), so what was asked for from a phone or another PC still installs here, and the pad's home button still
 * works; Ahoy can start with Windows, there and not in front (--hidden). A second start, the tray or a notification bring
 * the window back. notify shows a Windows notification while the window is not in front (the page says it itself when it
 * is); clicking it brings the window forward and tells the page which of its pages to open (event {type: "open", route}).
 *
 * The big screen is the server's page itself, zoomed for a television (window:zoom) on the whole display. The launcher can
 * ask the page for it: started with --big (also when it already runs: the second start hands it over), or by the home
 * button of a controller (Xbox, PS) when the setting padButton says so. That button is heard by a window that is never
 * shown (assets/pad.html with the preload pad.ts): the browser tells a page of the pads whether or not it is in front, so
 * the button works from inside a game. "show" brings the launcher's window to the front; "big" does that and asks the page
 * for the big screen. The page takes the wish once (big:take), when it is ready for it.
 *
 * The display (display.ts): the window and its smallest size are kept inside the work area of the display it is on (a small
 * panel at a high scale has less room than the usual minimum). A page is told what the PC knows of that display and the page
 * cannot see (display:get, and the event "display" when the window moves to another one or the monitors change): whether it
 * is the PC's own panel, and how large it really is, as the monitor says itself (read from Windows once per run, in the
 * background; nothing but a page's own question ever waits for it). A built-in panel of a few inches is a handheld's, whatever
 * Windows' scale: the server's page sizes its big screen by that, and the setup page takes the whole display there, larger,
 * with the pad (setup-pad.ts). The page's zoom goes under 1 too (a display with fewer points than the big screen's lines).
 *
 * A rejected call reaches the page as "Error invoking remote method '<channel>': Error: <message>"; a package that needs
 * a newer launcher fails install with a message holding "update-needed:".
 *
 * Who may call: only the window's top page, and only while it is the connected server's (its origin, compared whole) or
 * the launcher's own setup page (guard.ts). The window stays on those two; any other http(s) address opens in the system
 * browser, and nothing else (file:, a program's own scheme) is opened at all. What config:set takes is checked value by
 * value; from the server's page a new install folder must be one the person picked in the folder dialog, and a new
 * server address is asked about in a dialog of the launcher's own (forgetting the server needs neither).
 *
 * Which server: the saved address, compared as an address (its origin and path), not as text. A server that answers its
 * http address from https is kept by the https one, session and games with it; one that sends on to any other address is
 * never followed: the setup page shows where it leads, and the dialog above names the address it ends at.
 *
 * The setup page also lists the games on this PC with Play, so a server that does not answer keeps nobody from playing;
 * it looks for the saved server again by itself and goes back to it.
 */
import { app, BrowserWindow, ipcMain, dialog, screen, shell, Menu, Notification, Tray, nativeImage, safeStorage, type IpcMainInvokeEvent, type Rectangle } from "electron";
import { execFile } from "node:child_process";
import { readFile, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, hostname, userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { Engine, writeAtomic, type EngineEvent } from "./engine";
import { Updater } from "./updater";
import { ruleFor, type Places } from "./saves";
import { Saves } from "./savesync";
import { MONITOR_QUERY, boundsInside, displayInfo, panelOf, parseMonitors, windowFit, zoomOf, type DisplayInfo, type Mm, type Monitor } from "./display";
import { HIDDEN_ARG, answeredAt, configPatch, externalUrl, httpsUpgrade, noteOf, packConfig, pageKind, sameServer, sessionOf, unpackConfig, type Config, type Seal } from "./guard";

export type { Config };

/** files shipped with the app: <app root>/dist and /assets (the bundler bakes the source dir into the old-style dirname, so never use that) */
const appFile = (...p: string[]) => join(app.getAppPath(), ...p);
const userData = () => app.getPath("userData");
const configPath = () => join(userData(), "config.json");
const defaultConfig = (): Config => ({ serverUrl: "", libraryDir: join(homedir(), "Games", "Ahoy"), desktopShortcuts: true, padButton: "off", background: true, startWithWindows: false, syncSaves: true, token: "", user: "" });
/** an automated run: the window stays off the screen, and so do a tray icon and notifications (they are kept for the run to read) */
const automated = process.env.AHOY_HIDDEN === "1";
// Windows files a notification under the app that sent it: the name the installer gave the Start menu shortcut
if (process.platform === "win32") app.setAppUserModelId("app.ahoy.launcher");
const setupUrl = () => pathToFileURL(appFile("assets", "setup.html")).href;

/** the session token is sealed for this Windows account (DPAPI) before it goes to disk; usable once the app is ready */
const seal: Seal = {
  available: () => { try { return safeStorage.isEncryptionAvailable(); } catch { return false; } },
  seal: text => safeStorage.encryptString(text).toString("base64"),
  open: sealed => safeStorage.decryptString(Buffer.from(sealed, "base64")),
};

async function loadConfig(): Promise<Config> {
  // the file, or the whole copy a save left beside it when it had to write in place (engine.ts writeAtomic)
  for (const file of [configPath(), configPath() + ".bak"]) {
    let raw: Record<string, unknown>;
    try { raw = JSON.parse(await readFile(file, "utf8")); } catch { continue; }
    const c = unpackConfig(raw, defaultConfig(), seal);
    // a file from before the session was sealed: sealed now, so the plain copy does not stay on disk
    if (typeof raw?.token === "string" && raw.token && seal.available()) await saveConfig(c).catch(() => {});
    return c;
  }
  return defaultConfig();
}
/** whole or not at all: a crash or a power cut in the middle never leaves half a file (which would read as "no settings") */
async function saveConfig(c: Config) { await writeAtomic(configPath(), JSON.stringify(packConfig(c, seal), null, 2)); }

/**
 * Is there an Ahoy server at this address? `url` is the address to keep it by: the one asked for, or its https address when
 * the server sends http on to https. An address that sends on to any other one is not that server: not ok, and `sendsTo`
 * names where it leads, for the person to connect to by name (guard.ts answeredAt).
 */
export async function probeServer(serverUrl: string): Promise<{ ok: boolean; version?: string; detail: string; url?: string; sendsTo?: string }> {
  const base = serverUrl.replace(/\/+$/, "");
  try {
    const h = await fetch(base + "/api/health", { signal: AbortSignal.timeout(6000) });
    const hj = await h.json().catch(() => ({})) as { ok?: boolean; version?: string; app?: string };
    if (!hj.ok) return { ok: false, detail: `nothing answers at ${base} (HTTP ${h.status})` };
    if (hj.app !== "ahoy") return { ok: false, version: hj.version, detail: hj.app ? `that is ${hj.app}, not an Ahoy server` : "that is not an Ahoy server" };
    const at = answeredAt(base, h.url);
    if ("sendsTo" in at) return { ok: false, version: hj.version, detail: `that address sends on to ${at.sendsTo}`, sendsTo: at.sendsTo };
    return { ok: true, version: hj.version, detail: `Ahoy ${hj.version ?? ""}`.trim(), url: at.url };
  } catch (e: any) { return { ok: false, detail: e?.message ?? String(e) }; }
}

let win: BrowserWindow | null = null;
let config: Config = defaultConfig();
const engine = new Engine({
  dataDir: app.getPath("userData"),
  serverUrl: () => config.serverUrl,
  token: () => config.token,
  // a package that requires a newer launcher is refused before any download
  version: app.getVersion(),
  onEvent: (e: EngineEvent) => { win?.webContents.send("ahoy:event", e); },
  // desktop shortcuts carry Play's own arguments; one is the launcher's only while it starts something inside its game's
  // folder (read back from the .lnk), so the person's own are never rewritten or removed
  shortcuts: process.platform === "win32" ? {
    enabled: () => config.desktopShortcuts,
    dir: () => app.getPath("desktop"),
    write: (file, link) => shell.writeShortcutLink(file, "create", link),
    read: file => { try { return shell.readShortcutLink(file).target || null; } catch { return null; } },
  } : undefined,
});

/** the launcher's own updates come from whichever server it is connected to (/launcher/latest.yml) */
const updater = new Updater(s => { win?.webContents.send("ahoy:event", { type: "update", update: s }); }, { log: l => console.log(`[update] ${l}`) });

const uiUrl = () => config.serverUrl.replace(/\/+$/, "") + "/";
/** the server's page, the setup page, or neither */
const kindOfPage = (url: string) => pageKind(url, config.serverUrl, setupUrl());
/** a link that leaves the launcher: the system browser gets http and https, nothing else is handed to Windows */
const openOutside = (url: string) => { const ext = externalUrl(url); if (ext) void shell.openExternal(ext); };

function createWindow() {
  // on the display a new window opens on, and no larger than its work area: nor may its smallest size be (display.ts)
  const fit = windowFit(screen.getPrimaryDisplay().workAreaSize);
  win = new BrowserWindow({
    width: fit.width, height: fit.height, minWidth: fit.minWidth, minHeight: fit.minHeight, backgroundColor: "#101010", title: "Ahoy",
    autoHideMenuBar: true,
    // automated runs keep the window off the screen from the start; started with Windows, it waits by the clock
    show: !automated && !startHidden,
    // no native title bar: Ahoy's own top bar is the drag region and Windows draws its caption buttons over it, on a
    // see-through strip so they sit on whatever the page shows there (the Home's key art, the bar's own ground)
    titleBarStyle: "hidden", titleBarOverlay: { color: "#ffffff00", symbolColor: "#a4a4a4", height: 40 },
    webPreferences: { preload: appFile("dist", "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  Menu.setApplicationMenu(null);
  // stay on the server (or our own setup page); everything else opens in the system browser
  win.webContents.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (ev, url) => {
    if (!kindOfPage(url)) { ev.preventDefault(); openOutside(url); }
  });
  // a redirect is a navigation too: the server's address answering with another site's does not move the window there
  win.webContents.on("will-redirect", (ev, url, _inPlace, isMainFrame) => {
    if (isMainFrame && !kindOfPage(url)) { ev.preventDefault(); openOutside(url); }
  });
  // no menu, so wire the reload keys by hand
  win.webContents.on("before-input-event", (ev, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || ((input.control || input.meta) && input.key.toLowerCase() === "r")) { ev.preventDefault(); win?.webContents.reloadIgnoringCache(); }
    if (input.key === "F12" || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === "i")) { ev.preventDefault(); win?.webContents.toggleDevTools(); }
  });
  // closed, Ahoy stays by the clock while the setting says so (Quit there, an update, or Windows shutting down really close it)
  win.on("close", ev => { if (!quitting && config.background) { ev.preventDefault(); win?.hide(); } });
  win.on("session-end", () => { quitting = true; });
  // the pad watcher is a window too: it goes with this one, or the launcher would never quit
  win.on("closed", () => { win = null; padWin?.destroy(); padWin = null; pretendFull = null; fullBy = null; });
  // another display, or the same one at another scale: the window fits there, and the page is told where it is now
  // (moved: the person let go of it; move: every step on the way, and the only word of a move made by a shortcut)
  win.on("moved", onDisplay);
  // (the whole display left: the window is as it was before, and has its minimum again)
  win.on("leave-full-screen", onDisplay);
  win.on("move", () => { clearTimeout(moveTimer); moveTimer = setTimeout(() => { keepMinimum(); tellDisplay(); }, 300); });
  startHidden = false;
  return win;
}

/* ─────────── the display the window is on (display.ts) ─────────── */

/** Windows' monitors (null: not read yet, or they could not be), and the PC's own panel as an earlier run read it */
let monitors: Monitor[] | null = null;
let knownPanel: Mm | null = null;
const panelPath = () => join(userData(), "display.json");
let moveTimer: ReturnType<typeof setTimeout> | undefined, monitorTimer: ReturnType<typeof setTimeout> | undefined;

/** the display the window is on (the one a new window opens on while there is none), and the names of the others */
function windowDisplay() {
  const d = win && !win.isDestroyed() ? screen.getDisplayMatching(win.isMinimized() ? win.getNormalBounds() : win.getBounds()) : screen.getPrimaryDisplay();
  return { d, others: screen.getAllDisplays().filter(x => x.id !== d.id).map(x => x.label) };
}
const displayNow = (): DisplayInfo => { const { d, others } = windowDisplay(); return displayInfo(d, monitors, others, knownPanel); };

/** ask Windows for its monitors: their real size and how they are connected. Windows only; null when it cannot be asked */
function readMonitors(): Promise<Monitor[] | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const ps = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return new Promise(res => {
    try { execFile(ps, ["-NoProfile", "-NonInteractive", "-NoLogo", "-Command", MONITOR_QUERY], { windowsHide: true, timeout: 8000, maxBuffer: 1 << 20 }, (err, out) => res(err ? null : parseMonitors(String(out)))); }
    catch { res(null); }
  });
}
/** the read that is under way, or the last one: a page's question waits for it, nothing else does */
let learning: Promise<void> | null = null, reads = 0;
/** once per run, in the background, and again when a monitor comes or goes. The PC's own panel is kept for the next start:
 *  in its dock with the panel off, Windows no longer lists it */
function learnMonitors() {
  const turn = ++reads;
  learning = (async () => {
    const got = await readMonitors();
    if (turn !== reads) return;                              // a later read is under way: its answer is the one
    monitors = got;
    try {
      const { d, others } = windowDisplay();
      const panel = panelOf(d, got, others);
      if (panel && (panel.width !== knownPanel?.width || panel.height !== knownPanel?.height)) {
        knownPanel = panel;
        await writeAtomic(panelPath(), JSON.stringify({ host: hostname(), panel })).catch(() => {});
      }
    } catch { /* no display to ask of: the next question finds one */ }
    tellDisplay();
  })();
  return learning;
}
async function loadPanel() {
  try {
    const j = JSON.parse(await readFile(panelPath(), "utf8")) as { host?: unknown; panel?: { width?: unknown; height?: unknown } };
    const w = Number(j?.panel?.width), h = Number(j?.panel?.height);
    // (a profile that travelled to another PC brings that PC's panel: not this one's)
    if (j?.host === hostname() && w > 0 && h > 0) knownPanel = { width: w, height: h };
  } catch { /* none kept yet */ }
}

/** the page is told when what it was told last no longer holds */
let toldDisplay = "";
function tellDisplay() {
  if (!win || win.isDestroyed()) return;
  const info = displayNow(), key = JSON.stringify(info);
  if (key === toldDisplay) return;
  toldDisplay = key;
  win.webContents.send("ahoy:event", { type: "display", display: info });
}
/**
 * The smallest the window goes, on the display it is on now; and none at all while it has the whole display. A minimum is
 * the window's with its frame, and on the whole display, where it has none, Windows makes it a frame larger than that: with
 * a minimum of 980 × 640 the window was 1098 × 646 on a display of 1098 × 618 points (1080 lines at Windows' 175%) and
 * 990 × 645 on one of 960 × 540, hanging over the bottom and the right edge (measured 2026-11-23; with the minimum merely
 * fitted to such a display it still came out 6 points too tall). Without one it is the display, exactly.
 */
function keepMinimum(): Rectangle | null {
  if (!win || win.isDestroyed()) return null;
  const area = windowDisplay().d.workArea, whole = !!pretendFull || win.isFullScreen();
  const fit = whole ? { minWidth: 0, minHeight: 0 } : windowFit(area), [mw, mh] = win.getMinimumSize();
  if (mw !== fit.minWidth || mh !== fit.minHeight) win.setMinimumSize(fit.minWidth, fit.minHeight);
  return area;
}
/** and the window itself, when it is larger than that display has room for, or smaller than it may be there (not while it
 *  has the whole display, or none) */
function keepInside() {
  const area = keepMinimum();
  if (!area || !win || pretendFull || win.isFullScreen() || win.isMaximized() || win.isMinimized()) return;
  const b = win.getBounds(), fit = windowFit(area);
  if (b.width > area.width || b.height > area.height || b.width < fit.minWidth || b.height < fit.minHeight) win.setBounds(boundsInside(b, area));
}
function onDisplay() { keepInside(); tellDisplay(); }
/** a monitor came or went: Windows is asked again (a moment later: it is still settling) */
function onMonitors() { onDisplay(); clearTimeout(monitorTimer); monitorTimer = setTimeout(() => { void learnMonitors(); }, 1500); }

/** who asked for the whole display last. The setup page takes it on a screen held in the hands; the server's page that
 *  follows keeps it by asking for it itself (its big screen), and gets its window back when it does not */
let fullBy: "server" | "setup" | null = null;
/** how long the server's page has to ask for the whole display the setup page left it */
const FULL_GRACE = 2500;
/** an automated run's window never comes on screen (fullscreen would show it): it takes the display's size instead, and
 *  these are the bounds it had */
let pretendFull: Rectangle | null = null;
function setFull(on: boolean): boolean {
  if (!win || win.isDestroyed()) return false;
  // the minimum is lifted before the window takes the whole display (keepMinimum says why), and is back when it leaves
  if (!automated) {
    if (on) win.setMinimumSize(0, 0);
    win.setFullScreen(on);
    const now = win.isFullScreen();
    if (!now) keepMinimum();
    return now;
  }
  if (on && !pretendFull) { pretendFull = win.getBounds(); win.setMinimumSize(0, 0); win.setBounds(windowDisplay().d.bounds); }
  else if (!on && pretendFull) { const b = pretendFull; pretendFull = null; win.setBounds(b); keepMinimum(); }
  return on;
}
const isFull = () => (automated ? !!pretendFull : !!win?.isFullScreen());

/* ─────────── without its window: the tray, starting with Windows, notifications ─────────── */

/** really quitting (the tray's Quit, an update installing, Windows shutting down): the window closes instead of hiding */
let quitting = false;
app.on("before-quit", () => { quitting = true; });
/** started with Windows (--hidden) while it may stay by the clock: the first window is not shown */
let startHidden = false;
let tray: Tray | null = null;

/** the window back on the screen (the tray, a second start) */
function showWindow() {
  if (!win) { void showServerOrSetup(); return; }
  if (win.isMinimized()) win.restore();
  if (!automated) { win.show(); win.focus(); }
}
/** the icon by the clock: there while Ahoy may run without its window, gone while it may not */
function keepTray() {
  if (!config.background || automated) { tray?.destroy(); tray = null; return; }
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(nativeImage.createFromPath(appFile("assets", "tray.png")));
  tray.setToolTip("Ahoy");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "Open Ahoy", click: showWindow }, { type: "separator" }, { label: "Quit Ahoy", click: () => { quitting = true; app.quit(); } }]));
  tray.on("click", showWindow);
}
/** Ahoy among what starts with Windows, as the setting says. Only the installed app: an unpacked one (bun run start, the
 *  tests) is not what should start with Windows. Written only when it differs from what Windows has */
function keepLoginItem() {
  if (!app.isPackaged || process.platform !== "win32") return;
  try {
    if (app.getLoginItemSettings({ args: [HIDDEN_ARG] }).openAtLogin !== config.startWithWindows) app.setLoginItemSettings({ openAtLogin: config.startWithWindows, args: [HIDDEN_ARG] });
  } catch { /* the setting stays; the next start tries again */ }
}

/** notifications on screen (kept so a click still finds its handler), and those an automated run would have shown */
const shown = new Set<Notification>();
const unshown: { title: string; body: string; route: string | null; click: () => void }[] = [];
if (automated) (globalThis as { ahoyNotes?: unknown }).ahoyNotes = unshown;

/* ─────────── the big screen from outside the page: --big, a controller's home button ─────────── */

let wantBig = false;
/** ask the page for the big screen: it takes the wish when it can (at once when it is up, else when it has loaded) */
function askBig() {
  wantBig = true;
  win?.webContents.send("ahoy:event", { type: "big", on: true });
}

/**
 * The launcher's window in front of whatever has the screen. Windows lets no program in the background take the foreground
 * by asking: on top of everything for a moment gets the window shown and focused, then it is an ordinary window again; when
 * that did not give it the focus, minimised and restored does. Never in an automated run (the window stays off the screen).
 */
function surface() {
  if (!win || win.isDestroyed() || process.env.AHOY_HIDDEN === "1") return;
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true, "screen-saver");
  win.show(); win.moveTop(); win.focus();
  setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    win.setAlwaysOnTop(false);
    if (!win.isFocused()) { win.minimize(); win.restore(); win.focus(); }
  }, 250);
}

let padWin: BrowserWindow | null = null;
/** the window that hears the pads' home button: there while the setting wants the button, gone while it does not */
function watchPad() {
  const want = config.padButton !== "off" && !!win;
  if (!want) { padWin?.destroy(); padWin = null; return; }
  if (padWin && !padWin.isDestroyed()) return;
  padWin = new BrowserWindow({
    show: false, width: 200, height: 120, skipTaskbar: true, focusable: false, title: "Ahoy pad",
    // not throttled: a window that is never shown still counts as visible to its page, which is what the pads are told to
    webPreferences: { preload: appFile("dist", "pad.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  padWin.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  padWin.webContents.on("will-navigate", ev => ev.preventDefault());
  void padWin.loadFile(appFile("assets", "pad.html")).catch(() => {});
  padWin.on("closed", () => { padWin = null; });
}
ipcMain.on("pad:home", e => {
  if (!padWin || e.sender !== padWin.webContents || !win) return;
  if (config.padButton === "off") return;
  // in front already, the page has the pad: there is nothing to bring anywhere; "big" still asks for the big screen
  if (!(win.isFocused() && win.isVisible() && !win.isMinimized())) surface();
  if (config.padButton === "big") askBig();
});

/** the server is the same one at its https address: the games this PC recorded under the old address go with it first (so
 *  Play keeps asking the server how they start, and saves set aside come back), then the settings; the session stays */
async function serverNowAt(https: string) {
  await engine.serverMoved(config.serverUrl, https).catch(() => {});
  config = { ...config, serverUrl: https };
  await saveConfig(config).catch(() => {});
}

async function showServerOrSetup() {
  if (!win) createWindow();
  // a server that sends the launcher on to another address does not count as answering (probeServer): nothing follows it
  // by itself, the setup page says where it leads
  const p = config.serverUrl ? await probeServer(config.serverUrl) : null;
  if (p?.ok) {
    // an address spelled another way (capital letters, a default port) is the same server and stays as it was saved
    if (p.url && !sameServer(p.url, config.serverUrl)) await serverNowAt(p.url);
    await win?.loadURL(uiUrl());
    // the setup page had the whole display (a handheld): the server's page keeps it by asking for it (its big screen opens
    // by itself there); one that does not ask gets its window back
    if (fullBy === "setup") setTimeout(() => { if (fullBy === "setup" && win && kindOfPage(win.webContents.getURL()) === "server") { fullBy = null; setFull(false); } }, FULL_GRACE);
    lastBuild = await serverBuild(); updater.follow(config.serverUrl);
  }
  // loaded by the very address pageKind compares with: a folder name with a % in it reads the same on both sides
  else { updater.stop(); await win?.loadURL(setupUrl()); }
}

/* ── keep the window on the server's current UI build: a deploy changes the hashed bundle name ── */
let lastBuild = "";
async function serverBuild(): Promise<string> {
  try {
    const html = await (await fetch(uiUrl() + "?t=" + Date.now(), { signal: AbortSignal.timeout(6000), cache: "no-store" })).text();
    return /assets\/index-[^"']+\.js/.exec(html)?.[0] ?? "";
  } catch { return ""; }
}
setInterval(async () => {
  if (!win || !config.serverUrl || kindOfPage(win.webContents.getURL()) !== "server") return;
  const b = await serverBuild();
  if (b && lastBuild && b !== lastBuild) { lastBuild = b; win.webContents.reload(); }
  else if (b) lastBuild = b;
}, 30_000);

/* ─────────── IPC: what the web UI may ask for ─────────── */

type Page = "server" | "setup";
/** which trusted page is calling: the window's own top frame, on the server's origin or the setup page; anything else is refused */
function callerPage(e: IpcMainInvokeEvent): Page | null {
  const f = e.senderFrame;
  if (!win || e.sender !== win.webContents || !f || f.parent) return null;
  return kindOfPage(f.url);
}
function handle(channel: string, fn: (page: Page, ...args: any[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    const page = callerPage(e);
    if (!page) throw new Error("not available on this page");
    return fn(page, ...args);
  });
}

/** folders the person picked in the folder dialog during this run: the only new ones the server's page may set */
const pickedDirs = new Set<string>();

const publicConfig = () => ({ serverUrl: config.serverUrl, libraryDir: config.libraryDir, desktopShortcuts: config.desktopShortcuts, padButton: config.padButton, background: config.background, startWithWindows: config.startWithWindows, syncSaves: config.syncSaves, user: config.user, hasSession: !!config.token, version: app.getVersion(), platform: process.platform, hostname: hostname() });
handle("config:get", async () => publicConfig());
handle("config:probe", async (_p, patch: { serverUrl?: unknown } | undefined) => probeServer(String(patch?.serverUrl ?? config.serverUrl)));
handle("config:set", async (page, raw: unknown) => {
  const checked = configPatch(raw);
  if ("error" in checked) return { ok: false, error: checked.error };
  const patch = checked.patch;
  if (page === "server" && patch.libraryDir !== undefined && patch.libraryDir !== config.libraryDir && !pickedDirs.has(patch.libraryDir)) return { ok: false, error: "Pick a folder to install games into" };
  const next: Config = { ...config, ...patch };
  // forgetting the server: the session belonged to it
  if (patch.serverUrl === "") {
    next.token = ""; next.user = "";
    config = next; await saveConfig(config); void showServerOrSetup();
    return { ok: true, config: publicConfig() };
  }
  const connect = patch.serverUrl !== undefined;
  if (connect) {
    const p = await probeServer(patch.serverUrl!);
    // an address that sends on to another one is not taken in its place: the setup page gets that one to show, for the
    // person to connect to by name; the server's page is asked about it below
    if (!p.ok && !(p.sendsTo && page === "server")) return { ok: false, error: p.detail, ...(p.sendsTo ? { sendsTo: p.sendsTo } : {}) };
    const to = p.ok ? p.url ?? patch.serverUrl! : p.sendsTo!;
    const same = sameServer(to, config.serverUrl), https = !same && httpsUpgrade(config.serverUrl, to);
    // the server's own page ending up at another server: only with the person's yes to exactly that address, in a dialog
    // no page can draw
    if (page === "server" && !same && !https) {
      const r = await dialog.showMessageBox(win!, {
        type: "question", buttons: ["Cancel", "Connect"], defaultId: 0, cancelId: 0, noLink: true,
        message: "Connect Ahoy to another server?", detail: `${to}\n\nYou will be signed out of the server you are on now.`,
      });
      if (r.response !== 1) return { ok: false, error: "Cancelled" };
    }
    // the server it has already stays as it was saved, however it was spelled this time (its games are recorded under
    // that); the same one over https takes them along; another server: the session belonged to the old one
    next.serverUrl = same ? config.serverUrl : to;
    if (https) await engine.serverMoved(config.serverUrl, to).catch(() => {});
    else if (!same) { next.token = ""; next.user = ""; }
  }
  const moved = next.serverUrl !== config.serverUrl;
  config = next; await saveConfig(config);
  watchPad();                                              // the pad's home button is heard from now, or no more
  keepTray();                                              // by the clock from now, or no more
  if (patch.startWithWindows !== undefined) keepLoginItem();
  // the setup page's Connect always leads to the server, also to the one already saved (it was not answering before)
  if (connect && (moved || page === "setup")) void showServerOrSetup();
  return { ok: true, config: publicConfig() };
});
handle("session:set", async (_p, s: unknown) => {
  config = { ...config, ...sessionOf(s) };
  await saveConfig(config);
  return { ok: true };
});
handle("session:get", async () => (config.token ? { token: config.token, user: config.user } : null));
handle("config:pickDir", async () => {
  const r = await dialog.showOpenDialog(win!, { title: "Where should games be installed?", defaultPath: config.libraryDir, properties: ["openDirectory", "createDirectory"] });
  const dir = r.canceled ? null : r.filePaths[0] ?? null;
  if (dir) pickedDirs.add(dir);
  return dir;
});
handle("installed", () => engine.installed());
handle("window:fullscreen", (page, on: boolean) => { if (!win) return false; fullBy = on ? page : null; return setFull(!!on); });
handle("window:isFullscreen", () => isFull());
// the page's own zoom (the browser's, so the page lays itself out for a smaller or a larger window). Each page has its own:
// the server's for its big screen, the setup page's on a screen held in the hands. Between a half and four times
handle("window:zoom", (_p, factor: number) => {
  if (!win) return 1;
  const z = zoomOf(factor);
  win.webContents.setZoomFactor(z);
  return z;
});
// what the PC knows of the display the window is on (display.ts). The first read of the monitors is waited for, a short
// while: an answer without it could call a television a handheld, and the page would size itself twice. Not where the answer
// is whole without it: a display Electron itself calls built in, its size kept from an earlier run
handle("display:get", async () => {
  const sure = (d: DisplayInfo) => d.internal === true && d.inches != null;
  if (learning && !sure(displayNow())) await Promise.race([learning, new Promise(r => setTimeout(r, 5000))]);
  const info = displayNow();
  toldDisplay = JSON.stringify(info);
  return info;
});
handle("big:take", () => { const w = wantBig; wantBig = false; return w; });
// a Windows notification from the server's page, while the window is not in front (in front, the page says it itself).
// Clicked, the window comes forward and the page is told which of its pages to open
handle("notify", (page, raw: unknown) => {
  const n = page === "server" && win ? noteOf(raw) : null;
  if (!n) return false;
  if (win!.isVisible() && win!.isFocused() && !win!.isMinimized()) return false;
  const click = () => { surface(); if (n.route) win?.webContents.send("ahoy:event", { type: "open", route: n.route }); };
  if (automated) { unshown.push({ ...n, click }); return true; }
  if (!Notification.isSupported()) return false;
  const t = new Notification({ title: n.title, body: n.body, icon: appFile("assets", "notify.png") });
  shown.add(t);
  t.on("click", () => { shown.delete(t); click(); });
  t.on("close", () => { shown.delete(t); });
  t.show();
  return true;
});
// the room on the drive games are installed to (the folder may not be there yet: the nearest one above it that is)
handle("disk", async () => {
  let dir = config.libraryDir;
  for (let i = 0; i < 64; i++) {
    try { const s = await statfs(dir); return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) }; }
    catch { const up = dirname(dir); if (up === dir) return null; dir = up; }
  }
  return null;
});
/* saves in step with the server: only the server's page asks, and only for a game on this PC */
/** this PC's places a rule may start at (the game's folder is added per game) */
const savePlaces = (): Places => {
  let user = ""; try { user = userInfo().username; } catch { /* no name: rules that need it find nothing */ }
  const home = homedir();
  return {
    home, winAppData: app.getPath("appData"), winLocalAppData: process.env.LOCALAPPDATA || join(home, "AppData", "Local"), winDocuments: app.getPath("documents"),
    winPublic: process.env.PUBLIC || join(dirname(home), "Public"), winProgramData: process.env.ProgramData || process.env.ALLUSERSPROFILE || null, osUserName: user,
  };
};
const saves = new Saves({ dataDir: app.getPath("userData"), places: savePlaces, serverUrl: () => config.serverUrl, token: () => config.token, device: () => hostname() });
async function savesGame(page: Page, slug: unknown) {
  if (page !== "server") throw new Error("not available on this page");
  const g = await engine.forSaves(String(slug));
  if (!g) throw new Error("not installed");
  return g;
}
const syncOn = () => { if (!config.syncSaves) throw new Error("saves are not kept in step on this PC"); };
handle("saves:state", async (page, slug: unknown, key: string, rules: unknown) => saves.state(await savesGame(page, slug), key, rules));
handle("saves:push", async (page, slug: unknown, key: string, rules: unknown) => { syncOn(); const g = await savesGame(page, slug); return saves.push(g, key, rules, { gameId: g.gameId, name: g.name }); });
handle("saves:pull", async (page, slug: unknown, key: string, rules: unknown, id: number) => {
  syncOn();
  const g = await savesGame(page, slug);
  if (g.busy) throw new Error("the game is running — close it first");
  return saves.pull(g, key, rules, Number(id));
});
handle("saves:agree", async (page, slug: unknown, key: string, rules: unknown, snap: { id: number; digest: string }) => saves.agree(await savesGame(page, slug), key, rules, { id: Number(snap?.id), digest: String(snap?.digest ?? "") }));
// a folder the person points at as where a game keeps its saves: the folder dialog, and the folder as a rule (null: cancelled)
handle("saves:pick", async (page, slug: unknown) => {
  const g = await savesGame(page, slug);
  const r = await dialog.showOpenDialog(win!, { title: `Where does ${g.name} keep its saves?`, defaultPath: app.getPath("documents"), properties: ["openDirectory"] });
  const dir = r.canceled ? null : r.filePaths[0] ?? null;
  if (!dir) return null;
  const rule = ruleFor(dir, { ...savePlaces(), base: g.path });
  return rule ? { rule } : { error: "Pick a folder inside Documents, Saved Games, AppData or the game's own folder" };
});
handle("update:state", () => updater.state);
handle("update:check", () => updater.check());
handle("update:install", () => { updater.install(); });

// the shortcut is the engine's: written with the install (setting on, a game a shortcut can start), recorded with it
handle("install", (_p, packageId: number) => engine.install(Number(packageId), config.libraryDir));
handle("install:cancel", (_p, packageId: number) => { engine.cancel(Number(packageId)); return true; });
// saves are set aside for the next install of the game unless deleteSaves; its shortcut goes only while it starts the game
handle("uninstall", async (_p, slug: string, opts?: { deleteSaves?: boolean }) => {
  await engine.uninstall(String(slug), { deleteSaves: opts?.deleteSaves === true });
  return true;
});
handle("play", (_p, slug: string) => engine.play(String(slug)));
handle("openFolder", async (_p, slug: string) => {
  const g = (await engine.installed()).find(x => x.slug === slug);
  if (g) await shell.openPath(g.path);
  return !!g;
});
handle("state", async () => ({ installed: await engine.installed(), config: publicConfig() }));

/* ─────────── lifecycle ─────────── */

if (!app.requestSingleInstanceLock()) app.quit();
else {
  // a second start is this one asked to the front; with --big, to the big screen too
  app.on("second-instance", (_e, argv) => {
    if (!win) return;
    if (argv.includes("--big")) { surface(); askBig(); }
    else showWindow();                                     // also from by the clock, where it has no window on screen
  });
  app.whenReady().then(async () => {
    config = await loadConfig();
    wantBig = process.argv.includes("--big");
    startHidden = process.argv.includes(HIDDEN_ARG) && config.background;
    keepTray();
    keepLoginItem();
    // the monitors' own word of their size, in the background: the window does not wait for it
    await loadPanel();
    void learnMonitors();
    screen.on("display-metrics-changed", onDisplay);
    screen.on("display-added", onMonitors);
    screen.on("display-removed", onMonitors);
    await showServerOrSetup();
    watchPad();
    app.on("activate", () => { if (!win) void showServerOrSetup(); });
  });
  app.on("window-all-closed", () => { app.quit(); });
}
