/**
 * Ahoy launcher — the setup page with a pad, and on a screen held in the hands. The page (assets/setup.html) stays as it
 * is: its fields, its buttons, its own script. This is laid over it, as the big screen is laid over the app:
 *
 *   the focus      a pad's d-pad or stick, or the arrow keys, move a focus over the page's controls (the address, Browse,
 *                  each game's Play, Connect); A or Enter presses what it is on. It shows while the pad or the keys drive
 *                  (html[data-drive="pad"]) and hides when the pointer moves; the first press after that only shows it. The
 *                  pad is the page's only while its window has the focus: a game started from here keeps its own pad
 *   the keyboard   A on the address opens the page's own keyboard, made for an address (its marks in reach, how it starts
 *                  and Ahoy's port a press each). X takes a letter away, Menu or the last key connects, B closes it. A real
 *                  keyboard types into the field as always, and Enter there connects. On a handheld a finger on the address
 *                  opens it too (and one beside it closes it): whether Windows' own touch keyboard would come up is a
 *                  setting of Windows, so there it is kept down and the page's own is the one
 *   in the hands   on a handheld's own screen (display.ts inHands, by what the launcher knows of the display) the page takes
 *                  the whole display and is zoomed to the lines the app's big screen shows there, the focus on from the
 *                  start. The same on any display the window already fills (the server went away under the big screen).
 *                  F11 gives the window back, or takes the display
 *
 * Bundled for the page by build.ts (dist/setup-pad.js). No word of it reaches the launcher but what the bridge offers any
 * page: the display, the whole display, the page's zoom.
 */
import { inHands, zoomOf, type DisplayInfo } from "./display";
import { LETTERS, PadReader, QUICK, SYMBOLS, startKey, stepFrom, typeKey, type Box, type Cmd, type Dir } from "./setup-keys";

interface Bridge {
  display?(): Promise<DisplayInfo>;
  fullscreen(on: boolean): Promise<boolean>;
  isFullscreen(): Promise<boolean>;
  zoom(factor: number): Promise<number>;
  onEvent(cb: (e: { type?: string; on?: boolean; display?: DisplayInfo }) => void): () => void;
}
/** the lines of the page a display shows while the page has all of it: in the hands, and across the room (as the app's big screen) */
const HAND_LINES = 600, ROOM_LINES = 720;

const L = (window as unknown as { ahoyLauncher?: Bridge }).ahoyLauncher;
const html = document.documentElement;

/** the page's address field and its Connect are what this is laid over */
function setup(field: HTMLInputElement, go: HTMLButtonElement) {
  html.dataset.pad = "";                                   // the page's own focus look steps back for this one

  /* ─────────── the focus ─────────── */

  /** what the focus rests on, as the page reads (a button that is off for a moment is still a place to be) */
  const stops = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>("#server, #pick, #games button, #go")).filter(e => e.getClientRects().length > 0);
  const box = (e: HTMLElement): Box => { const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
  /** where it is on the page, and where among the stops that was (a game's row is drawn anew when it starts: the focus stays in its place) */
  let current: HTMLElement | null = null, place = 0;
  /** the keyboard: its sheet once made, whether it is up, and the key the focus is on */
  let sheet: HTMLElement | null = null, typing = false, keyAt: HTMLElement | null = null, shift = false, symbols = false;
  /** on a handheld's own screen, the whole of it (set by fit): the address is typed on the page's keyboard, by pad or finger */
  let inHand = false;
  /** Windows' own touch keyboard stays down while the page's is up, and on a handheld altogether */
  const quiet = () => { if (typing || inHand) field.setAttribute("inputmode", "none"); else field.removeAttribute("inputmode"); };
  const reader = new PadReader();

  const driven = () => html.dataset.drive === "pad";
  /** the one thing that shows the focus */
  function mark(el: HTMLElement | null) {
    document.querySelectorAll("[data-pf]").forEach(e => { if (e !== el) e.removeAttribute("data-pf"); });
    if (el && driven()) el.dataset.pf = "";
  }
  const remark = () => mark(typing ? keyAt : current);
  function drive(by: "pad" | "mouse") {
    if (html.dataset.drive === by) return;
    html.dataset.drive = by;
    remark(); hint();
  }
  /** the focus goes to a control of the page */
  function rest(el: HTMLElement | null) {
    current = el;
    if (el) {
      place = Math.max(0, stops().indexOf(el));
      if (document.activeElement !== el) el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    remark(); hint();
  }
  /** where it is when nobody has put it anywhere: what the page has focused, else the address */
  const landing = (): HTMLElement | null => { const s = stops(), a = document.activeElement as HTMLElement | null; return (a && s.includes(a) ? a : null) ?? s[0] ?? null; };
  function move(dir: Dir) {
    const s = stops(), to = stepFrom(s.map(box), s.indexOf(current!), dir);
    if (to >= 0) rest(s[to]!);
  }

  /* ─────────── the keyboard ─────────── */

  const ICON = {
    shift: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 5H9l-6 7 6 7h12zM17 9l-6 6M11 9l6 6"/></svg>',
  };
  const setValue = (v: string) => { field.value = v; field.dispatchEvent(new Event("input", { bubbles: true })); };
  function put(key: string) {
    setValue(typeKey(field.value, shift && key.length === 1 ? key.toUpperCase() : key));
    if (shift) { shift = false; keys(); }
  }
  /** the keys, drawn for the letters or the marks; the focus stays on the key of the same name */
  function keys() {
    const rows = sheet!.querySelector(".osk-rows")!, at = keyAt?.dataset.k;
    const key = (k: string, label: string, cls = "") => `<button type="button" tabindex="-1" class="key${cls ? " " + cls : ""}" data-k="${k.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${label}</button>`;
    const text = (c: string) => c.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    rows.innerHTML = (symbols ? SYMBOLS : LETTERS).map(r => `<div class="osk-row">${[...r].map(c => key(c, text(shift && !symbols ? c.toUpperCase() : c))).join("")}</div>`).join("")
      + `<div class="osk-row">${key("shift", ICON.shift, `wide${shift ? " on" : ""}`)}${key("symbols", symbols ? "abc" : "!#1", "wide")}${QUICK.map(q => key(q, q, "quick")).join("")}${key("back", ICON.back, "wide")}${key("done", "Connect", "done")}</div>`;
    keyAt = Array.from(rows.querySelectorAll<HTMLElement>(".key")).find(e => e.dataset.k === at) ?? rows.querySelector<HTMLElement>(".key");
    remark();
  }
  function press(el: HTMLElement | null) {
    const k = el?.dataset.k;
    if (!k) return;
    if (k === "shift") { shift = !shift; keys(); }
    else if (k === "symbols") { symbols = !symbols; shift = false; keys(); }
    else if (k === "done") close(true);
    else put(k);
  }
  /** the sheet shows what the field holds and what the page says of it (its status line is under the sheet) */
  function mirror() {
    if (!sheet) return;
    sheet.querySelector(".osk-text bdi")!.textContent = field.value;
    const msg = document.getElementById("msg"), to = sheet.querySelector<HTMLElement>(".osk-status")!;
    to.className = `osk-status ${msg?.className ?? ""}`;
    to.textContent = msg?.textContent ?? "";
  }
  function make() {
    sheet = document.createElement("div");
    sheet.className = "osk"; sheet.hidden = true;
    sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-label", "Keyboard");
    sheet.innerHTML = '<div class="osk-field"><span class="osk-name">Server address</span><span class="osk-text"><bdi></bdi><i class="osk-caret"></i></span><span class="osk-status"></span></div><div class="osk-rows"></div>';
    // a key takes no focus from the field (a real keyboard keeps typing there)
    sheet.addEventListener("mousedown", e => e.preventDefault());
    sheet.addEventListener("click", e => { const k = (e.target as HTMLElement).closest<HTMLElement>(".key"); if (k) { keyAt = k; remark(); press(k); } });
    document.body.appendChild(sheet);
    field.addEventListener("input", mirror);
    const msg = document.getElementById("msg");
    if (msg) new MutationObserver(mirror).observe(msg, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  }
  function open() {
    if (!sheet) make();
    typing = true; shift = false; symbols = false; keyAt = null;
    sheet!.hidden = false;
    quiet();
    if (document.activeElement !== field) field.focus({ preventScroll: true });
    keys();
    keyAt = Array.from(sheet!.querySelectorAll<HTMLElement>(".key")).find(e => e.dataset.k === startKey(field.value)) ?? keyAt;
    mirror(); remark(); hint();
  }
  /** closed: back on the address, or on Connect, pressed */
  function close(connect: boolean) {
    if (!typing) return;
    typing = false; keyAt = null;
    sheet!.hidden = true;
    quiet();
    rest(connect ? go : field);
    if (connect) go.click();
  }
  function onKeys(c: Cmd) {
    switch (c) {
      case "ok": return press(keyAt);
      case "back": return close(false);
      case "delete": return put("back");
      case "done": return close(true);
      default: {
        const all = Array.from(sheet!.querySelectorAll<HTMLElement>(".key")), to = stepFrom(all.map(box), all.indexOf(keyAt!), c);
        if (to >= 0) { keyAt = all[to]!; remark(); }
      }
    }
  }

  /* ─────────── what a press does ─────────── */

  function command(c: Cmd) {
    const asleep = !driven();
    drive("pad");
    if (typing) return onKeys(c);
    if (!current || !current.isConnected) { rest(landing()); return; }
    // the pad picked up after the pointer (or for the first time): this press only shows where the focus is
    if (asleep) { rest(current); return; }
    switch (c) {
      case "up": case "down": case "left": case "right": return move(c);
      case "ok": if (current === field) open(); else current.click(); return;
      default: return;
    }
  }

  const ARROWS: Record<string, Dir> = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "F11") { e.preventDefault(); void whole(!full, true); return; }
    if (e.key === "Tab") { drive("pad"); return; }
    const dir = ARROWS[e.key], inField = e.target === field;
    if (typing) {
      // letters go to the field; the arrows walk the keys, Enter connects, Esc closes
      if (dir) { e.preventDefault(); command(dir); }
      else if (e.key === "Enter") { e.preventDefault(); close(true); }
      else if (e.key === "Escape") { e.preventDefault(); close(false); }
      return;
    }
    if (dir) {
      if (inField && (dir === "left" || dir === "right")) return;       // the caret's
      e.preventDefault(); command(dir);
    } else if (e.key === "Enter" && inField) { e.preventDefault(); go.click(); }
  });
  // the pointer says where the person is: the focus hides (a finger moves it too)
  let mx = -1, my = -1;
  window.addEventListener("mousemove", (e: MouseEvent) => { if (mx >= 0 && Math.hypot(e.clientX - mx, e.clientY - my) > 6) drive("mouse"); mx = e.clientX; my = e.clientY; });
  // on a handheld a finger (or a pointer) on the address brings the page's keyboard up, and one beside it takes it down
  field.addEventListener("click", () => { if (inHand && !typing) open(); });
  document.addEventListener("pointerdown", e => { const t = e.target as Node; if (typing && t !== field && !sheet!.contains(t)) close(false); });
  // the page's own focus is followed (Tab, a click)
  document.addEventListener("focusin", e => { const t = e.target as HTMLElement; if (!typing && t !== current && stops().includes(t)) { current = t; place = stops().indexOf(t); remark(); hint(); } });
  // a game's row is drawn anew when it starts or stops: the focus keeps its place in the list
  const games = document.getElementById("games");
  if (games) new MutationObserver(() => {
    if (!current || current.isConnected) return;
    const s = stops();
    current = s[Math.min(place, s.length - 1)] ?? null;
    if (driven() && !typing) rest(current);
  }).observe(games, { childList: true });

  const tick = () => {
    let pads: ReturnType<Navigator["getGamepads"]> = [];
    try { pads = navigator.getGamepads?.() ?? []; } catch { /* no pads on this page */ }
    const had = reader.seen;
    for (const c of reader.read(pads, performance.now(), !document.hidden && document.hasFocus())) command(c);
    if (reader.seen !== had) hint();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  /* ─────────── what the buttons do, said at the bottom (to a pad: a keyboard knows its Enter) ─────────── */

  const hints = document.createElement("div");
  hints.className = "hints"; hints.setAttribute("aria-hidden", "true");
  document.body.appendChild(hints);
  function hint() {
    const list: [string, string][] = !reader.seen ? []
      : typing ? [["A", "Type"], ["X", "Delete"], ["☰", "Connect"], ["B", "Close"]]
      : [["A", current === field ? "Type" : "Select"]];
    hints.innerHTML = list.map(([g, label]) => `<span><kbd>${g}</kbd>${label}</span>`).join("");
    hints.hidden = !list.length;
  }
  hint();

  /* ─────────── a screen held in the hands ─────────── */

  let info: DisplayInfo | null = null, full = false;
  /** the person gave the window back themselves (F11): it is not taken again */
  let left = false;
  const touch = navigator.maxTouchPoints > 0;
  /** the page as large as the display it has all of asks for; its own size in a window */
  async function fit() {
    if (!L) return;
    const hand = !!info && inHands(info, touch);
    try {
      full = await L.isFullscreen();
      if (hand && !full && !left) full = await L.fullscreen(true);
      await L.zoom(full && info && info.points.height > 0 ? zoomOf(Math.round(info.points.height / (hand ? HAND_LINES : ROOM_LINES) * 100) / 100) : 1);
    } catch { return; }
    html.toggleAttribute("data-roomy", full);
    inHand = hand && full; quiet();
    // nothing else says where the person is on a screen without a pointer: the focus is on from the start
    if (full && !html.dataset.drive) { drive("pad"); rest(current ?? landing()); }
  }
  async function whole(on: boolean, byPerson = false) {
    if (!L) return;
    if (byPerson) left = !on;
    try { await L.fullscreen(on); } catch { /* stays as it is */ }
    await fit();
  }
  if (L) {
    L.onEvent(e => {
      if (e.type === "display" && e.display) { info = e.display; void fit(); }
      // the launcher asks for the big screen (the pad's home button): here that is the whole display
      if (e.type === "big") void whole(e.on !== false);
    });
    void (L.display ? L.display() : Promise.resolve(null)).then(d => { info = d; }, () => { /* it does not say */ }).then(fit);
  }
}

const field = document.getElementById("server") as HTMLInputElement | null, go = document.getElementById("go") as HTMLButtonElement | null;
if (field && go) setup(field, go);
