/** Ahoy launcher — the bridge the server's web UI sees as window.ahoyLauncher. */
import { contextBridge, ipcRenderer } from "electron";

declare const __AHOY_VERSION__: string;        // baked in by build.ts from package.json

const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld("ahoyLauncher", {
  version: __AHOY_VERSION__,
  // "argv" (0.10.0): packages that start with an argument list, environment and {install}; keep/seed (saves survive
  // updates and uninstalls, uninstall takes {deleteSaves}); "update-needed:" for a package that needs a newer launcher.
  // "launch-refresh" (0.11.0): Play asks the server how the game starts now and takes a start the server changed in
  // place, so a copy whose start changed needs no Update
  // "zoom", "big", "pad-button" (0.12.0): the page's own zoom (the big screen is the app zoomed for a television); the big
  // screen asked for from outside the page (--big, a controller's home button); the setting for that button (padButton)
  // "saves" (0.13.0): a game's saves kept in step with the server (the page decides what to do, the launcher does it), and the
  // setting syncSaves
  // "notify", "disk", "background" (0.13.0): a Windows notification while the window is not in front (clicked, it opens a
  // page of the app); the room on the drive games go to; the settings background and startWithWindows (closed, Ahoy stays
  // by the clock; it starts with Windows)
  // "display", "zoom-out" (0.14.0): what the PC knows of the display the window is on (its real size, whether it is the PC's
  // own panel: a handheld is known by that, whatever Windows' scale), told again when it changes (event "display"); the
  // page's zoom goes down to a half (a display with fewer points than the big screen has lines)
  features: ["ahoy", "frameless", "sessions", "updates", "fullscreen", "argv", "launch-refresh", "script-start", "blocks", "zoom", "big", "pad-button", "notify", "disk", "background", "saves", "display", "zoom-out"],
  config: () => invoke("config:get"),
  probe: (patch: Record<string, unknown>) => invoke("config:probe", patch),
  setConfig: (patch: Record<string, unknown>) => invoke("config:set", patch),
  setSession: (s: { token: string; user: string } | null) => invoke("session:set", s),
  session: () => invoke("session:get"),
  pickDir: () => invoke("config:pickDir"),
  state: () => invoke("state"),
  installed: () => invoke("installed"),
  install: (packageId: number) => invoke("install", packageId),
  cancelInstall: (packageId: number) => invoke("install:cancel", packageId),
  /** the game's saves are set aside for its next install; deleteSaves wipes them instead */
  uninstall: (slug: string, opts?: { deleteSaves?: boolean }) => invoke("uninstall", slug, { deleteSaves: opts?.deleteSaves === true }),
  play: (slug: string) => invoke("play", slug),
  openFolder: (slug: string) => invoke("openFolder", slug),
  /** the whole screen, natively (so Esc stays the page's own key); false gives the window back */
  fullscreen: (on: boolean) => invoke("window:fullscreen", !!on),
  isFullscreen: () => invoke("window:isFullscreen"),
  /** the page's zoom: 1 is its real size, from a half to four times; the answer is the zoom it now has */
  zoom: (factor: number) => invoke("window:zoom", Number(factor)),
  /** the display the window is on, as the PC knows it (display.ts DisplayInfo): { internal, mm, inches, panel, points, scale } */
  display: () => invoke("display:get"),
  /** was the big screen asked for (a start with --big, the pad's home button)? True once per asking */
  wantsBig: () => invoke("big:take"),
  /** a Windows notification, shown while the window is not in front (the answer says whether it was shown) */
  notify: (n: { title: string; body?: string; route?: string }) => invoke("notify", n),
  /** the room on the drive games are installed to: { free, total } in bytes, or null */
  disk: () => invoke("disk"),
  /** a game's saves on this PC and on the server (savesync.ts): look, bring there, take from there, note that both agree,
   *  and point at a folder by hand */
  saves: {
    state: (slug: string, key: string, rules: unknown) => invoke("saves:state", slug, key, rules),
    push: (slug: string, key: string, rules: unknown) => invoke("saves:push", slug, key, rules),
    pull: (slug: string, key: string, rules: unknown, id: number) => invoke("saves:pull", slug, key, rules, id),
    agree: (slug: string, key: string, rules: unknown, snap: { id: number; digest: string }) => invoke("saves:agree", slug, key, rules, snap),
    pick: (slug: string) => invoke("saves:pick", slug),
  },
  updateState: () => invoke("update:state"),
  checkUpdate: () => invoke("update:check"),
  installUpdate: () => invoke("update:install"),
  onEvent: (cb: (e: unknown) => void) => {
    const h = (_: unknown, e: unknown) => cb(e);
    ipcRenderer.on("ahoy:event", h);
    return () => ipcRenderer.removeListener("ahoy:event", h);
  },
});
