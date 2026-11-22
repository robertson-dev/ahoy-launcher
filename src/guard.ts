/**
 * Ahoy launcher — what the main process checks before it trusts anything from outside: where the window may go, which
 * page may use the bridge, which links leave for the system browser, what a page may put into the saved settings, what
 * it may say in a notification, which address updates may come from, and how the settings file is written (the session
 * sealed for this Windows account).
 *
 * Plain functions with no Electron in them, so they run under bun test; main.ts and updater.ts wire them in.
 */
import { isAbsolute } from "node:path";

/** what a controller's home button (Xbox, PS) does while the launcher runs: nothing, bring the window to the front, or that
 *  and the big screen */
export type PadButton = "off" | "show" | "big";
export const PAD_BUTTONS: readonly PadButton[] = ["off", "show", "big"];
const padButton = (v: unknown): PadButton | null => (typeof v === "string" && (PAD_BUTTONS as readonly string[]).includes(v) ? v as PadButton : null);

export interface Config {
  serverUrl: string; libraryDir: string; desktopShortcuts: boolean; padButton: PadButton;
  /** closing the window leaves Ahoy running by the clock (the tray): what was asked for elsewhere still installs here */
  background: boolean;
  /** Ahoy starts with Windows, by the clock and not in front */
  startWithWindows: boolean;
  /** this PC's saves are kept in step with the server (brought there after playing, taken from there before) */
  syncSaves: boolean;
  /** the signed-in session: the page hands it over after a sign-in, and takes it back on sign-out */
  token: string; user: string;
}

const parse = (url: unknown): URL | null => { try { return typeof url === "string" ? new URL(url) : null; } catch { return null; } };
const web = (u: URL | null): u is URL => !!u && (u.protocol === "http:" || u.protocol === "https:");

/** the origin of an http(s) address, or "" (an origin is compared whole: a prefix of it is another site) */
export function originOf(url: unknown): string {
  const u = parse(url);
  return web(u) ? u.origin : "";
}

/** an address a person may connect to: http(s), a host, no sign-in baked in; trailing slashes dropped. null when it is not one */
export function serverAddress(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\/+$/, "");
  const u = parse(s);
  if (!web(u) || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  return s;
}

/** a file address's path as one thing to compare: escapes undone (two spellings of one path), case folded as Windows does */
const filePath = (u: URL): string => { try { return decodeURIComponent(u.pathname).toLowerCase(); } catch { return u.pathname.toLowerCase(); } };

/** which page this is: the connected server's ("server"), the launcher's own setup page ("setup"), or neither (null) */
export function pageKind(url: unknown, serverUrl: string, setupFileUrl: string): "server" | "setup" | null {
  const u = parse(url);
  if (!u) return null;
  if (u.protocol === "file:") {
    const s = parse(setupFileUrl);
    // exactly the setup page (Windows paths compare without case); never any other file
    return s && s.protocol === "file:" && u.host === s.host && filePath(u) === filePath(s) ? "setup" : null;
  }
  const o = originOf(serverUrl);
  return web(u) && !!o && u.origin === o ? "server" : null;
}

/** the link as the system browser may open it: only http and https ever leave the launcher */
export function externalUrl(url: unknown): string | null {
  const u = parse(url);
  return web(u) ? u.href : null;
}

/** the address the server answered at: a server that sends http on to https is kept by its https address */
export function answeredBase(asked: string, answeredUrl: string | undefined): string {
  const base = asked.replace(/\/+$/, "");
  const a = parse(base), u = parse(answeredUrl);
  const tail = "/api/health";
  if (!web(a) || !web(u) || !u.pathname.endsWith(tail)) return base;
  const got = (u.origin + u.pathname.slice(0, -tail.length)).replace(/\/+$/, "");
  return got === base ? base : got;
}
/** the same server, now over https: the one change of address the launcher takes without asking */
export function httpsUpgrade(from: string, to: string): boolean {
  const a = parse(from), b = parse(to);
  if (!web(a) || !web(b)) return false;
  return a.protocol === "http:" && b.protocol === "https:" && a.hostname === b.hostname && a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
}
/** one server, however its address is spelled: the same origin and path (capital letters in the host, a default port
 *  written out, a slash at the end are the same address; URL does the folding) */
export function sameServer(a: unknown, b: unknown): boolean {
  const x = parse(a), y = parse(b);
  return web(x) && web(y) && x.origin === y.origin && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
}
/**
 * What the launcher takes from a look at `asked`, given the address that answered: `asked` as it is spelled when its own
 * address answered; its https address when the server sent http on to https; and `sendsTo` when it sent on to any other
 * address, which is never taken in its place: the person connects to that one by name, or not at all.
 */
export function answeredAt(asked: string, answeredUrl: string | undefined): { url: string } | { sendsTo: string } {
  const base = asked.replace(/\/+$/, "");
  const got = answeredBase(base, answeredUrl);
  if (got === base || sameServer(base, got)) return { url: base };
  return httpsUpgrade(base, got) ? { url: got } : { sendsTo: got };
}

/** a host on this PC or its own network: loopback, the private and link-local ranges, a bare name, a home-network name */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h) return false;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (v4.slice(1).some(n => Number(n) > 255)) return false;
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) {                                   // IPv6
    if (h === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateHost(mapped[1]!);
    return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  }
  if (!h.includes(".")) return true;                       // a bare name only this network answers for
  return /\.(local|lan|home|internal|home\.arpa)$/.test(h);
}

/**
 * May the launcher's own updates come from this server address? Over https always; over plain http only from this PC or
 * its own network (anyone between the PC and an http address on the internet could answer with their own build).
 * null when it may, else why not, in words for the person.
 */
export function updateFeedProblem(serverUrl: string): string | null {
  const u = parse(serverUrl);
  if (!web(u)) return "Updates are off: the server address is not a web address";
  if (u.protocol === "https:" || isPrivateHost(u.hostname)) return null;
  return "Updates are off: this server's address is not https";
}

/**
 * Is a published build one to download? Every file it names must come from the feed's own address (the same origin, over
 * the same scheme) and carry the sha512 the download is checked against. null when it is, else why not.
 */
export function updateFilesProblem(info: { files?: { url?: unknown; sha512?: unknown }[] | null } | null | undefined, feed: string): string | null {
  const base = parse(feed.replace(/\/+$/, "") + "/");
  if (!web(base)) return "no feed";
  const files = info?.files ?? [];
  if (!files.length) return "the update names no file";
  for (const f of files) {
    if (typeof f?.sha512 !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(f.sha512)) return "the update carries no checksum";
    let u: URL;
    try { u = new URL(String(f.url ?? ""), base); } catch { return "the update names a file that is no address"; }
    if (u.origin !== base.origin) return "the update points at another address";
  }
  return null;
}

/** what config:set may change, checked: anything else a page sends is ignored. `error` when a value it may set is wrong */
export type ConfigPatch = { serverUrl?: string; libraryDir?: string; desktopShortcuts?: boolean; padButton?: PadButton; background?: boolean; startWithWindows?: boolean; syncSaves?: boolean };
export function configPatch(patch: unknown): { patch: ConfigPatch } | { error: string } {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const out: ConfigPatch = {};
  if (p.serverUrl !== undefined) {
    if (p.serverUrl === "") out.serverUrl = "";            // forget the server
    else {
      const s = serverAddress(p.serverUrl);
      if (s === null) return { error: "The address needs to start with http:// or https://" };
      out.serverUrl = s;
    }
  }
  if (p.libraryDir !== undefined) {
    if (typeof p.libraryDir !== "string" || !p.libraryDir.trim() || !isAbsolute(p.libraryDir) || p.libraryDir.includes("\0")) return { error: "Pick a folder to install games into" };
    out.libraryDir = p.libraryDir;
  }
  if (p.desktopShortcuts !== undefined) {
    if (typeof p.desktopShortcuts !== "boolean") return { error: "That did not save" };
    out.desktopShortcuts = p.desktopShortcuts;
  }
  if (p.padButton !== undefined) {
    const b = padButton(p.padButton);
    if (!b) return { error: "That did not save" };
    out.padButton = b;
  }
  for (const k of ["background", "startWithWindows", "syncSaves"] as const) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== "boolean") return { error: "That did not save" };
    out[k] = p[k] as boolean;
  }
  return { patch: out };
}

/** the argument Ahoy is started with when it starts with Windows: there by the clock, its window not shown */
export const HIDDEN_ARG = "--hidden";

/**
 * What the server's page may have said in a Windows notification: a title, a line under it, and the page of the app to
 * open when it is clicked (one of the app's own paths; anything else is no page). Control characters go, the lengths are
 * kept short. null when there is no title to show.
 */
export function noteOf(n: unknown): { title: string; body: string; route: string | null } | null {
  const o = (n && typeof n === "object" ? n : {}) as Record<string, unknown>;
  const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");
  const title = clean(o.title, 120);
  if (!title) return null;
  const route = typeof o.route === "string" && /^\/[A-Za-z0-9/_-]{0,200}$/.test(o.route) && !o.route.startsWith("//") ? o.route : null;
  return { title, body: clean(o.body, 200), route };
}

/** the session a page hands over: a token and a name, both text (anything else is no session) */
export function sessionOf(s: unknown): { token: string; user: string } {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const token = typeof o.token === "string" && o.token.length <= 4096 ? o.token : "";
  return { token, user: token && typeof o.user === "string" ? o.user.slice(0, 200) : "" };
}

/** seals text for this Windows account (Electron's safeStorage); absent or not available: the text is kept as it is */
export interface Seal { available(): boolean; seal(text: string): string; open(sealed: string): string }

/** the settings as they go to disk: the session token sealed (tokenSealed) whenever sealing works, never beside a plain copy */
export function packConfig(c: Config, seal?: Seal): Record<string, unknown> {
  const out: Record<string, unknown> = { serverUrl: c.serverUrl, libraryDir: c.libraryDir, desktopShortcuts: c.desktopShortcuts, padButton: c.padButton, background: c.background, startWithWindows: c.startWithWindows, syncSaves: c.syncSaves, user: c.user };
  if (c.token) {
    let sealed: string | null = null;
    try { if (seal?.available()) sealed = seal.seal(c.token); } catch { sealed = null; }
    if (sealed) out.tokenSealed = sealed; else out.token = c.token;
  }
  return out;
}

/** the settings as read from disk: every value checked (a wrong one is the default), the session opened again; a file from before sealing still signs in */
export function unpackConfig(raw: unknown, def: Config, seal?: Seal): Config {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c: Config = {
    serverUrl: r.serverUrl === undefined || r.serverUrl === "" ? def.serverUrl : serverAddress(r.serverUrl) ?? "",
    libraryDir: typeof r.libraryDir === "string" && r.libraryDir.trim() && isAbsolute(r.libraryDir) ? r.libraryDir : def.libraryDir,
    desktopShortcuts: typeof r.desktopShortcuts === "boolean" ? r.desktopShortcuts : def.desktopShortcuts,
    padButton: padButton(r.padButton) ?? def.padButton,
    background: typeof r.background === "boolean" ? r.background : def.background,
    startWithWindows: typeof r.startWithWindows === "boolean" ? r.startWithWindows : def.startWithWindows,
    syncSaves: typeof r.syncSaves === "boolean" ? r.syncSaves : def.syncSaves,
    token: "", user: typeof r.user === "string" ? r.user : "",
  };
  if (typeof r.tokenSealed === "string" && r.tokenSealed) { try { c.token = seal?.available() ? seal.open(r.tokenSealed) : ""; } catch { c.token = ""; } }
  else if (typeof r.token === "string") c.token = r.token;
  // an older launcher talked to the engine with an API key: that address is not an Ahoy server, so the setup page asks again
  if (r.apiKey !== undefined) { c.serverUrl = ""; c.token = ""; }
  if (!c.token || !c.serverUrl) { c.token = ""; c.user = ""; }
  return c;
}
