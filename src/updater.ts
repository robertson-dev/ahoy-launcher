/**
 * Ahoy launcher — keeps itself current. The server it is connected to publishes the launcher build under
 * /launcher/ (the installer, electron-builder's latest.yml and the blockmap); this follows that feed, downloads a
 * newer build in the background, and installs it when the person restarts (or when the app quits).
 *
 * The builds are not code-signed, so what stands between the feed and the PC is checked here (guard.ts): the feed is
 * followed over https, or over plain http only on this PC's own network; a build is downloaded only when every file it
 * names comes from the feed's own address and carries the sha512 the download is then checked against (electron-updater
 * refuses a file that does not match).
 */
import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { updateFeedProblem, updateFilesProblem } from "./guard";

/** "off": updates are not followed from this server's address, and checking changes nothing; `error` then says why, in
 *  words for the person. It is a standing fact about the address, not a failed update, so it is no "error" */
export interface UpdateState {
  status: "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error" | "off";
  version: string | null; percent: number; error: string | null; checkedAt: number | null;
}

const EVERY = 4 * 3600_000;          // re-check while running
const FIRST = 15_000;                // after connecting, once the page is up

export class Updater {
  state: UpdateState = { status: "idle", version: null, percent: 0, error: null, checkedAt: null };
  private feed = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;

  constructor(private onState: (s: UpdateState) => void, opts: { log?: (line: string) => void; devConfig?: string; installOnQuit?: boolean } = {}) {
    const log = opts.log ?? (() => {});
    autoUpdater.autoDownload = false;                                  // downloaded from here, once the build has been looked at
    autoUpdater.autoInstallOnAppQuit = opts.installOnQuit ?? true;     // a downloaded build installs when the app closes (tests say no)
    autoUpdater.allowDowngrade = false;
    autoUpdater.logger = { info: (m: unknown) => log(String(m)), warn: (m: unknown) => log(`warn: ${String(m)}`), error: (m: unknown) => log(`error: ${String(m)}`), debug: () => {} };
    if (opts.devConfig) { autoUpdater.forceDevUpdateConfig = true; autoUpdater.updateConfigPath = opts.devConfig; }   // tests: an unpacked app against a local feed
    autoUpdater.on("checking-for-update", () => this.set({ status: "checking", error: null }));
    autoUpdater.on("update-available", (i: UpdateInfo) => {
      const problem = updateFilesProblem(i, this.feed);
      if (problem) { log(`refused ${i.version}: ${problem}`); return this.set({ status: "error", version: null, percent: 0, error: "That update could not be trusted", checkedAt: Date.now() }); }
      this.set({ status: "available", version: i.version, percent: 0 });
      autoUpdater.downloadUpdate().catch(() => { /* reported through the error event */ });
    });
    autoUpdater.on("update-not-available", () => this.set({ status: "none", version: null, percent: 0, checkedAt: Date.now() }));
    autoUpdater.on("download-progress", p => this.set({ status: "downloading", percent: p.percent }));
    autoUpdater.on("update-downloaded", (i: UpdateInfo) => this.set({ status: "ready", version: i.version, percent: 100, checkedAt: Date.now() }));
    autoUpdater.on("error", e => {
      // a server that publishes no build yet is not an error worth a red line
      if (/404|latest\.yml/i.test(String(e?.message))) return this.set({ status: "none", version: null, percent: 0, checkedAt: Date.now(), error: null });
      this.set({ status: "error", error: String(e?.message ?? e).split("\n")[0].slice(0, 160) });
    });
  }

  private set(patch: Partial<UpdateState>) { this.state = { ...this.state, ...patch }; this.onState(this.state); }
  /** an unpacked app (bun run start, tests) has nothing to update unless a dev config says otherwise */
  enabled() { return app.isPackaged || autoUpdater.forceDevUpdateConfig; }

  /** follow the build this server publishes; a different server means a different feed */
  follow(serverUrl: string) {
    const feed = serverUrl.replace(/\/+$/, "") + "/launcher";
    if (feed === this.feed) return;
    // an address anyone on the way could answer for gets no say in what is installed here
    const problem = updateFeedProblem(serverUrl);
    if (problem) { this.stop(); return this.set({ status: "off", version: null, percent: 0, error: problem, checkedAt: null }); }
    // a server before this one had updates off: that was said of its address, not of this one
    if (this.state.status === "off") this.set({ status: "idle", error: null });
    this.feed = feed;
    autoUpdater.setFeedURL({ provider: "generic", url: feed, useMultipleRangeRequest: false });
    this.stopTimers();
    if (!this.enabled()) return;
    this.first = setTimeout(() => void this.check(), FIRST);
    this.timer = setInterval(() => void this.check(), EVERY);
  }
  /** the launcher forgot its server */
  stop() { this.feed = ""; this.stopTimers(); }
  private stopTimers() { if (this.first) clearTimeout(this.first); if (this.timer) clearInterval(this.timer); this.first = this.timer = null; }

  async check(): Promise<UpdateState> {
    if (!this.enabled() || !this.feed) return this.state;
    if (this.state.status === "checking" || this.state.status === "downloading" || this.state.status === "ready") return this.state;
    try { await autoUpdater.checkForUpdates(); } catch { /* reported through the error event */ }
    return this.state;
  }
  /** quit, install silently, start the new build */
  install() { if (this.state.status === "ready") autoUpdater.quitAndInstall(true, true); }
}
