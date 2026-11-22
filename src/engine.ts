/**
 * Ahoy launcher — the engine: install a package from the Ahoy server, verify it, run prerequisites, play, update in
 * place, uninstall.
 *
 * Plain Node APIs only (it runs inside Electron's main process and under bun test). A game comes as blocks when the server
 * can send it so (pull/blocks.ts: a few requests instead of one per file, compressed where that helps, every block
 * checked against its sha256 as it arrives, and on an update only the blocks that changed). Otherwise it comes file by
 * file, as it always did: the server's own segmented, resumable HTTP pull engine, fed by the package manifest instead of
 * a directory listing, then every file hashed against the manifest. Either way what is on disk is what the manifest
 * lists. Every request carries the signed-in session (Authorization: Bearer), the same one the page uses.
 *
 * What a manifest may say besides its files (from 0.10.0, for the recomps, ports and emulators the server builds):
 *   launch.argv   the arguments as a list, used as they are; without it, launch.args split on spaces as always
 *   launch.env    variables put over the launcher's own environment for the game
 *   {install}     in argv items, cwd and env values: the absolute install folder; on Windows a value it was put into
 *                 gets backslashes throughout
 *   keep          globs of saves and settings: one already on disk is the player's, so an update never fetches,
 *                 verifies, resets or deletes it; uninstall sets them aside in <library>/.ahoy-keep/<slug>/ and the
 *                 next install of that game puts them back
 *   seed          globs of files shipped once: one already on disk is never fetched or verified again
 *   requires      {launcher}: the oldest launcher that can run it; an older one fails before any download, with a
 *                 message that starts "update-needed:"
 * Globs are anchored at the install folder: * and ? stay inside one folder, ** spans folders (or none), {a,b} is
 * either; case does not matter. Every path a manifest names must stay inside the install folder.
 *
 * A start is a program. On Windows it may also be a command script of the game (.bat or .cmd; from 0.11.0, feature
 * "script-start"), for a game whose own script is how it starts. Windows runs a script through its command shell, which
 * reads a command line as commands, so the shell is never handed anything it could read that way: the script's path goes
 * to it in a variable (AHOY_START, expanded once, inside quotes), and a script's arguments are plain words only (letters,
 * digits and . _ - + = , : / \ @): a start with any other argument is not installed and never started. The script then does
 * what it says, with the player's rights. When it hands the game on and ends (one that asks for administrator rights starts
 * itself again and exits at once), the game counts as running for as long as a program holds one of the game's programs.
 *
 * How a game starts can change after it is installed (from 0.11.0, feature "launch-refresh"): the server's admin may
 * correct a package's start in place — the same package, the same files, a new launch.rev. Play asks the server for the
 * package's start first (GET /api/v1/package/:id/launch, at most LAUNCH_ASK_MS) and takes a changed one when an install
 * would: a program (.exe on Windows) this launcher installed for that package, inside the game's folder, needing no newer
 * launcher. The record follows, and so does the desktop shortcut this launcher made for the game (rewritten while the
 * person's setting is on, removed while it is off: a shortcut to the old program would be worse than none). Anything else
 * (offline, signed out, no answer in time, the package replaced, a start it must not follow) starts the recorded launch,
 * as before: Play never depends on the server. A changed start Play does not take is noted on the record (skippedRev), so
 * the page offers Update for it; a game recorded under another server address is never asked about (the page offers it
 * Update by its address). Play is refused while the game is being installed or removed.
 *
 * The slug names the install folder, so it stands for one game: another game with the same slug (a different gameId
 * from the same server) is refused rather than installed over it, and saves set aside go back only into the game they
 * came from. A game deleted on the server and added again has a new gameId, so it counts as another game here too: what
 * it set aside before stays set aside. A desktop shortcut is this launcher's only while it starts something inside the
 * game's folder. An update or an uninstall is refused while a running program holds a file it would replace or delete,
 * which sees a game started outside Ahoy too.
 *
 * Kept in dataDir: installed.json (the games on this PC), installed-files/<slug>.json (the files each game was
 * installed with, so an update deletes only files this launcher put there), installed-blocks/<slug>.json and .blk (what
 * a game taken as blocks holds: the next update, or a download picked up again, starts from it), kept.json (where
 * set-aside saves wait, and whose they are). installed.json and kept.json change one edit at a time, each on the list as it is then; an edit
 * that cannot read its list leaves it as it is, rather than write back what it could not read. A list written in place (its
 * file held against renaming) leaves a whole copy beside it (<file>.bak) until the next save made the usual way.
 */
import { mkdir, rm, readFile, writeFile, stat, lstat, open, readdir, rename, copyFile, unlink, rmdir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { join, dirname, posix, isAbsolute, resolve, basename, sep } from "node:path";
import { startHttpPull, PART_EXT, type HttpSource, type RemoteEntry } from "./pull/pull-http";
import { startBlockPull, blocksInfoOf, dropBlockState, type BlocksInfo } from "./pull/blocks";
import type { PullHandle } from "./pull/pull";

export interface ManifestFile { path: string; size: number; sha256: string }
/** "rom" is a console dump nothing on a PC opens by itself; every other kind starts launch.exe */
export type PackageKind = "native" | "rom" | "recomp" | "port" | "emulated";
export interface Launch {
  exe: string; args: string; cwd: string;
  /** the arguments as a list, used as they are; `args` is the same joined by spaces, for launchers before 0.10.0 */
  argv?: string[];
  env?: Record<string, string>;
  /** when the server last changed this start in place (an opaque stamp; absent when it never did) */
  rev?: number | string | null;
}
/** the server's word on how a package starts now (GET /api/v1/package/:id/launch) */
export interface LaunchInfo {
  launch: Launch | null;
  rev?: number | string | null;
  /** the oldest launcher that can follow it, as a manifest says it */
  requires?: { launcher?: string } | null;
  kind?: string | null;
}
export interface Manifest {
  schema: 1; name: string; slug: string; version: string | null;
  launch: Launch;
  prerequisites: { kind: string; path: string; args: string }[];
  files: ManifestFile[]; totalSize: number;
  /** "rom": a console dump — nothing a PC can launch; `launch.exe` is the image / package / dump marker. A kind this
   *  launcher does not know counts as "native" */
  kind?: PackageKind;
  platform?: string | null;
  /** the oldest launcher that can install and start it */
  requires?: { launcher?: string };
  /** saves and settings kept across updates and uninstalls; files shipped once and never reset */
  keep?: string[];
  seed?: string[];
}
/** blocks: how the server can send the package as blocks ({size, count, digest}: pull/blocks.ts), when it can */
export interface PackageInfo { id: number; gameId: number | null; name: string; version: string | null; size: number | null; manifest: Manifest; blocks?: unknown }
export interface InstalledGame {
  slug: string; gameId: number | null; packageId: number; name: string; version: string | null;
  path: string; launch: Launch; kind: PackageKind; platform: string | null;
  sizeBytes: number; installedAt: number; serverUrl: string;
  /** the manifest's keep and seed globs (absent on games installed before 0.10.0) */
  keep?: string[]; seed?: string[];
  /** the desktop shortcut this launcher made for the game: the only one uninstall removes */
  shortcut?: string | null;
  /** the stamp (launch.rev) of a start the server changed in place that Play did not take on this PC (0.11.0 on): the
   *  page offers Update for it, which installs the package again */
  skippedRev?: number | string;
}
export type Phase = "downloading" | "verifying" | "prerequisites" | "finishing" | "done" | "failed" | "cancelled";
export interface InstallProgress {
  type: "install"; packageId: number; gameId: number | null; slug: string; name: string; phase: Phase;
  progress: number; bytes: number; total: number; rate: number; message?: string;
}
export type EngineEvent = InstallProgress
  | { type: "installed-changed"; installed: InstalledGame[] }
  | { type: "play"; slug: string; running: boolean; pid?: number; code?: number | null; message?: string };

/** starts a game: Node's spawn, swapped in tests */
export type SpawnGame = (exe: string, args: string[], opts: SpawnOptions) => ChildProcess;
/** desktop shortcuts (Windows): main.ts hands in Electron's shell.writeShortcutLink and shell.readShortcutLink */
export interface ShortcutOpts {
  /** the person's setting (desktopShortcuts), read at every install */
  enabled(): boolean;
  /** where shortcuts go (the desktop) */
  dir(): string;
  /** write a .lnk file; false when it could not */
  write(file: string, link: { target: string; args: string; cwd: string; description: string }): boolean;
  /** what a .lnk file starts (its target), or null when it cannot be read as a shortcut */
  read(file: string): string | null;
}

export interface EngineOpts {
  dataDir: string;                                  // where installed.json lives
  serverUrl: () => string;
  token: () => string;
  onEvent: (e: EngineEvent) => void;
  /** this launcher's version (app.getVersion()): a package that requires a newer one is refused before any download */
  version?: string;
  fetchImpl?: typeof fetch;
  /** run a prerequisite installer; resolves with its exit code (injectable for tests / non-Windows) */
  runInstaller?: (exe: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<number>;
  /** how long one prerequisite installer may take before it is stopped and the install goes on (default INSTALLER_MAX_MS) */
  installerMaxMs?: number;
  spawnGame?: SpawnGame;
  /** absent: no shortcuts (anything but Windows) */
  shortcuts?: ShortcutOpts;
  segments?: number;
  /** a game is taken as blocks when the server can send it so; false: always file by file. The rest is for tests */
  blocks?: false | { streams?: number; requestBytes?: number; retries?: number; sleep?: (ms: number) => Promise<void> };
  /** how long Play waits for the server's word on how a game starts (default LAUNCH_ASK_MS) */
  launchAskMs?: number;
  /** a game started through a script, once the script has ended: how often its programs are looked at (default
   *  SCRIPT_WATCH_MS), and how long the game has to appear before it counts as not started (default SCRIPT_HANDOVER_MS) */
  scriptWatchMs?: number;
  scriptHandoverMs?: number;
}

/** where uninstall sets saves aside, beside the games in the library folder (a slug never starts with a dot) */
export const KEEP_DIR = ".ahoy-keep";
/** how long one prerequisite installer may run: one that waits for an answer nobody can give (its window is hidden) is stopped */
export const INSTALLER_MAX_MS = 15 * 60_000;
/** how long Play waits for the server's word on how a game starts, before it starts what it has */
export const LAUNCH_ASK_MS = 3000;
/** the most of the server's word on how a game starts that Play reads (a start is a few hundred bytes) */
const LAUNCH_ANSWER_MAX = 64 * 1024;
/** a start's stamp, as text: at most this long */
const REV_MAX = 64;
/** the old space-separated arguments: at most this long */
const ARGS_MAX = 32 * 1024;
/** what Windows takes as one command line (the program and its arguments), and as one variable */
const COMMAND_LINE_MAX = 32_767;
const INSTALL = "{install}";
/** a Windows command script: the one kind of script that may start a game (a name Windows would read as one, with dots
 *  or spaces behind it, is no start at all) */
const START_SCRIPT = /\.(bat|cmd)$/i, SCRIPT_LIKE = /\.(bat|cmd)[. ]*$/i;
/** what an argument handed to a start script may hold: everything else the command shell reads as its own (a space ends an
 *  argument, % expands a variable, & starts another command, a quote opens one) */
export const SCRIPT_ARG = /^[A-Za-z0-9_.,:=+/\\@-]+$/;
/** the variable a start script's path is handed to the command shell in */
export const SCRIPT_VAR = "AHOY_START";
/** a script that ended may have handed the game on (to a program it started, or to itself with administrator rights, which
 *  the player first has to allow): the game has this long to appear, and is looked for this often */
export const SCRIPT_HANDOVER_MS = 90_000, SCRIPT_WATCH_MS = 3000;
const KINDS: readonly string[] = ["native", "rom", "recomp", "port", "emulated"];
const onWindows = process.platform === "win32";
/** the fields of a launch this launcher knows: a start with any other (one a newer launcher would read) is not taken at Play */
const LAUNCH_KEYS: ReadonlySet<string> = new Set(["exe", "args", "cwd", "argv", "env", "rev"]);
/** two launches the same: program, arguments, folder, variables and stamp (the order of the variables aside) */
const launchKey = (l: Launch | null | undefined) => JSON.stringify(l ? [l.exe ?? "", l.args ?? "", l.cwd ?? "", l.argv ?? null,
  l.env ? Object.entries(l.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) : null, l.rev ?? null] : null);
/** a start's stamp, when it is one a record can keep (a number, or a short text), else null */
const stampOf = (rev: unknown): number | string | null =>
  (typeof rev === "number" && Number.isFinite(rev)) || (typeof rev === "string" && rev.length > 0 && rev.length <= REV_MAX) ? rev : null;
/** the server's start filled in as a record keeps it (args and cwd always there; the answer's stamp when the start has
 *  none of its own), or null when the answer holds no start */
function serverStart(said: LaunchInfo): Launch | null {
  const l: unknown = said.launch;
  if (!l || typeof l !== "object" || Array.isArray(l)) return null;
  const x = l as Partial<Launch>;
  const launch = { ...x, args: typeof x.args === "string" ? x.args : "", cwd: typeof x.cwd === "string" ? x.cwd : "" } as Launch;
  if (launch.rev === undefined && said.rev != null) launch.rev = said.rev;
  return launch;
}
/** a record without the note of a start Play skipped */
const unnoted = (g: InstalledGame): InstalledGame => { const { skippedRev: _skipped, ...rest } = g; return rest; };

/** the kind an installed game is recorded with: one this launcher does not know counts as native, as it always has */
export const kindOf = (k: unknown): PackageKind => (typeof k === "string" && KINDS.includes(k) ? (k as PackageKind) : "native");

const semver = (v: unknown): number[] | null => {
  const m = typeof v === "string" ? /^\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
};
/** is version `have` at least `need` (major.minor.patch; a pre-release counts as its release; an unreadable one is not) */
export function versionAtLeast(have: unknown, need: unknown): boolean {
  const h = semver(have), n = semver(need);
  if (!h || !n) return false;
  for (let i = 0; i < 3; i++) if (h[i] !== n[i]) return h[i] > n[i];
  return true;
}

/**
 * Why a manifest path (or a keep / seed glob) would not stay inside the install folder on Windows, or null when it
 * does: relative, no drive or stream (no ':'), no '..' nor a name Windows reads as one (only dots and spaces), no empty
 * folder name, no character Windows refuses in a name (a glob may hold * and ?).
 */
export function pathProblem(p: unknown, opts: { glob?: boolean } = {}): string | null {
  if (typeof p !== "string" || !p) return "is empty";
  if (p.length > 1024) return "is too long";
  if ((opts.glob ? /[<>:"|\u0000-\u001f]/ : /[<>:"|?*\u0000-\u001f]/).test(p)) return "holds a character Windows does not allow in a path";
  if (/^[\\/]/.test(p)) return "is not inside the install folder";
  for (const seg of p.split(/[\\/]/)) {
    if (!seg) return "has an empty folder name";
    if (/^[. ]+$/.test(seg)) return "climbs out of the install folder";
  }
  return null;
}

/** the install folder's name: one path segment, not hidden (the keep folder lives beside the games), no trailing dot or
 *  space (Windows would drop it) */
export function safeSlug(s: unknown): s is string {
  return typeof s === "string" && s.length <= 200 && !/[\\/]/.test(s) && !/^\.|[. ]$/.test(s) && pathProblem(s) === null;
}

const fold = (p: string) => (onWindows ? p.toLowerCase() : p);
/** is `p` the folder `root` or inside it, as written (see realWithin for links) */
export function within(root: string, p: string): boolean {
  const r = fold(resolve(root)), q = fold(resolve(p));
  return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep);
}
/** within, after following links: a junction inside the folder must not lead a delete or a move outside it */
async function realWithin(root: string, p: string): Promise<boolean> {
  try { return within(await realpath(root), await realpath(p)); } catch { return false; }
}

/** one glob as a regular expression over a forward-slash path */
function globRegex(glob: string): RegExp {
  const segs = glob.replace(/\\/g, "/").split("/");
  let out = "";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") out += last ? ".*" : "(?:[^/]*/)*";
    else out += segRegex(seg) + (last ? "" : "/");
  });
  return new RegExp(`^${out}$`, "i");
}
function segRegex(seg: string): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === "*") { while (seg[i + 1] === "*") i++; out += "[^/]*"; }
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const end = seg.indexOf("}", i), body = end > i ? seg.slice(i + 1, end) : "";
      if (body.includes(",") && !body.includes("{")) { out += `(?:${body.split(",").map(segRegex).join("|")})`; i = end; }
      else out += "\\{";
    } else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}
/** keep / seed globs as one test over install-relative paths; a glob that would leave the folder matches nothing */
export function globMatcher(globs: readonly unknown[] | null | undefined): (rel: string) => boolean {
  const res = (globs ?? []).filter((g): g is string => pathProblem(g, { glob: true }) === null).map(globRegex);
  if (!res.length) return () => false;
  return rel => { const r = rel.replace(/\\/g, "/"); return res.some(re => re.test(r)); };
}

/** {install} put into one argv item, cwd or env value; on Windows that value then gets backslashes throughout */
export function fillInstall(s: string, install: string, platform: string = process.platform): string {
  if (!s.includes(INSTALL)) return s;
  const out = s.split(INSTALL).join(install);
  return platform === "win32" ? out.replace(/\//g, "\\") : out;
}

/** the game's variables over the launcher's own; on Windows a name in another case is the same variable, so it replaces it */
export function mergeEnv(base: Record<string, string | undefined>, extra: Record<string, string>, foldCase: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) out[k] = v;
  for (const [k, v] of Object.entries(extra)) {
    if (foldCase) for (const have of Object.keys(out)) if (have.toUpperCase() === k.toUpperCase()) delete out[have];
    out[k] = v;
  }
  return out;
}

export interface LaunchCommand {
  /** what is started, with these arguments: the game's program, or Windows' command shell for a script */
  exe: string; args: string[]; cwd: string; env: Record<string, string> | null;
  /** the game's own file that starts it, inside its folder: the program, or the script */
  file: string;
  /** the game's own arguments (a program's are `args`; a script's are what follows its path on the shell's command line) */
  own: string[];
  /** a command script: `args` is the shell's command line and is passed as it is written, never quoted again */
  script: boolean;
}
/**
 * How Play starts an installed game: the program and working folder inside the install folder, argv as listed with
 * {install} filled in (the old space-separated args when there is no argv, untouched), env over the launcher's own (null:
 * the launcher's own as it is). A command script (Windows only) is handed to the command shell by its path in a variable,
 * with plain-word arguments only. Throws for a path outside the folder, a script elsewhere than on Windows, or a script
 * with an argument the shell could read as a command.
 */
export function launchCommand(g: Pick<InstalledGame, "path" | "launch">, o: { platform?: string; baseEnv?: Record<string, string | undefined> } = {}): LaunchCommand {
  const platform = o.platform ?? process.platform;
  const install = resolve(g.path), l = g.launch;
  const exeProblem = pathProblem(l.exe);
  const exe = exeProblem ? "" : resolve(install, l.exe);
  if (exeProblem || !within(install, exe)) throw new Error("the game's program is not inside its folder");
  const script = SCRIPT_LIKE.test(l.exe);
  if (script && !START_SCRIPT.test(l.exe)) throw new Error("this game starts through a script whose name is not a plain .bat or .cmd");
  if (script && platform !== "win32") throw new Error("this game starts through a Windows command script (.bat or .cmd), which only Windows runs");
  const fill = (s: string) => fillInstall(s, install, platform);
  const args = Array.isArray(l.argv) ? l.argv.map(fill) : typeof l.args === "string" && l.args ? l.args.split(" ").filter(Boolean) : [];
  let cwd = dirname(exe);
  if (l.cwd && l.cwd.startsWith(INSTALL)) cwd = resolve(fill(l.cwd));
  else if (l.cwd) {
    if (pathProblem(l.cwd)) throw new Error("the game's working folder is not inside its folder");
    cwd = resolve(install, l.cwd);
  }
  if (!within(install, cwd)) throw new Error("the game's working folder is not inside its folder");
  const extra = l.env && typeof l.env === "object" ? Object.entries(l.env) : [];
  const vars = Object.fromEntries(extra.map(([k, v]) => [k, fill(String(v))]));
  const base = o.baseEnv ?? process.env;
  if (!script) return { exe, args, cwd, env: extra.length ? mergeEnv(base, vars, platform === "win32") : null, file: exe, own: args, script: false };
  // the command shell reads its command line as commands: it gets the script's path in a variable (expanded once, inside
  // quotes: whatever the path holds, it stays one path) and arguments that are plain words, or the game is not started
  if (args.some(a => !SCRIPT_ARG.test(a))) throw new Error("this game starts through a script, and one of its arguments is more than a plain word: Ahoy hands a script nothing the command shell could read as a command");
  if (extra.some(([k]) => k.toUpperCase() === SCRIPT_VAR)) throw new Error(`this game starts through a script and sets ${SCRIPT_VAR}, which is the launcher's own`);
  const shell = join(base.SystemRoot || base.windir || "C:\\Windows", "System32", "cmd.exe");
  // /d: no AutoRun commands from the registry; /v:off: a ! in a path stays a !; /s /c "…": what follows, as it is written
  const line = `""%${SCRIPT_VAR}%"${args.length ? ` ${args.join(" ")}` : ""}"`;
  return { exe: shell, args: ["/d", "/v:off", "/s", "/c", line], cwd, env: mergeEnv(base, { ...vars, [SCRIPT_VAR]: exe }, true), file: exe, own: args, script: true };
}

/** one argument the way Windows programs read their command line back (a shortcut carries the arguments as text) */
export function quoteArg(a: string): string {
  if (a !== "" && !/[\s"]/.test(a)) return a;
  let out = '"', slashes = 0;
  for (const ch of a) {
    if (ch === "\\") { slashes++; continue; }
    out += ch === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return out + "\\".repeat(slashes * 2) + '"';
}

/** a desktop shortcut's file name: Windows forbids <>:"/\|?* (a colon silently writes an NTFS stream instead of a file) */
export const shortcutName = (name: string) => `${name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "") || "Game"}.lnk`;

/** what a desktop shortcut starts: the same program (or script: Windows starts a .bat or .cmd shortcut through its command
 *  shell itself), folder and arguments as Play; null when a shortcut cannot start the game (a console dump, a start Play
 *  would refuse, a game that needs its own environment, which a .lnk cannot carry) */
export function shortcutFor(g: InstalledGame): { target: string; args: string; cwd: string } | null {
  if (g.kind === "rom" || (g.launch.env && Object.keys(g.launch.env).length)) return null;
  let c: LaunchCommand;
  try { c = launchCommand(g); } catch { return null; }
  const args = c.own.map(quoteArg).join(" ");
  return args.length > 1024 ? null : { target: c.file, args, cwd: c.cwd };
}

/**
 * A package is refused before any download when it needs a newer launcher ("update-needed: …", which the page can tell
 * apart from other failures) or when anything it names would leave its install folder or does not have the shape a
 * launcher can follow.
 */
export function checkManifest(m: Manifest | null | undefined, version: string): void {
  if (!m?.files?.length || !m.slug) throw new Error("the package manifest is empty");
  if (!meetsRequires(m.requires, version))
    throw new Error(`update-needed: this game needs ${semver(m.requires?.launcher) ? `Ahoy ${m.requires?.launcher} or newer` : "a newer Ahoy"} (this PC has ${version})`);
  if (!safeSlug(m.slug)) throw unsafe("its folder name", "is not one plain folder name");
  for (const f of m.files) {
    if (!f || typeof f !== "object" || typeof f.size !== "number" || !(f.size >= 0)) throw unsafe("its file list", "is broken");
    checkPath(`the file "${String(f.path)}"`, f.path);
  }
  checkLaunch(m.launch);
  if (m.prerequisites !== undefined && m.prerequisites !== null && !Array.isArray(m.prerequisites)) throw unsafe("its setup list", "is not a list");
  for (const p of m.prerequisites ?? []) checkPath(`the setup file "${String(p?.path)}"`, p?.path);
  for (const k of ["keep", "seed"] as const) {
    const globs = m[k];
    if (globs === undefined || globs === null) continue;
    if (!Array.isArray(globs)) throw unsafe(`its ${k} list`, "is not a list");
    for (const g of globs) checkPath(`the ${k} pattern "${String(g)}"`, g, true);
  }
}

/** does this launcher meet a manifest's requires (absent, or {} with no launcher, asks nothing; one it cannot read is not met) */
export function meetsRequires(requires: unknown, version: string): boolean {
  if (requires === undefined || requires === null) return true;
  const need: unknown = typeof requires === "object" ? (requires as { launcher?: unknown }).launcher : null;
  return need === undefined || versionAtLeast(version, need);
}

const unsafe = (what: string, why: string) => new Error(`the package is not safe to install: ${what} ${why}`);
const checkPath = (what: string, p: unknown, glob = false) => { const e = pathProblem(p, { glob }); if (e) throw unsafe(what, e); };
/** a launch of the shape a launcher can follow, every path inside the install folder (throws why not, as checkManifest does) */
export function checkLaunch(l: unknown): asserts l is Launch {
  if (!l || typeof l !== "object" || Array.isArray(l)) throw unsafe("its launch", "is missing");
  const x = l as Launch;
  checkPath("its program", x.exe);
  if (x.cwd !== undefined && x.cwd !== null && x.cwd !== "") {
    if (typeof x.cwd !== "string") throw unsafe("its working folder", "is not text");
    // install-relative, or {install} and a path below it ("{install}bin" would be a folder beside it)
    const after = x.cwd.startsWith(INSTALL) ? x.cwd.slice(INSTALL.length) : null;
    if (after && !/^[\\/]/.test(after)) throw unsafe("its working folder", "is not inside the install folder");
    const rest = after === null ? x.cwd : after.replace(/^[\\/]/, "");
    if (rest !== "") checkPath("its working folder", rest);
    if (rest.includes(INSTALL)) throw unsafe("its working folder", "names {install} somewhere but its start");
  }
  if (x.argv !== undefined && (!Array.isArray(x.argv) || x.argv.some(a => typeof a !== "string" || a.includes("\0")))) throw unsafe("its arguments", "are not a list of text");
  // a script's arguments go through the command shell: plain words, or the package is not one to install
  if (typeof x.exe === "string" && SCRIPT_LIKE.test(x.exe)) {
    const own = Array.isArray(x.argv) ? x.argv : typeof x.args === "string" && x.args ? x.args.split(" ").filter(Boolean) : [];
    if (own.some(a => !SCRIPT_ARG.test(a))) throw unsafe("its start script", "is handed an argument that is more than a plain word");
  }
  if (x.env !== undefined && x.env !== null) {
    if (typeof x.env !== "object" || Array.isArray(x.env)) throw unsafe("its environment", "is not a list of variables");
    for (const [k, v] of Object.entries(x.env)) if (!k || /[=\0]/.test(k) || typeof v !== "string" || v.includes("\0")) throw unsafe(`its variable "${k}"`, "is not a name and a text value");
  }
}

/* ─────────── files on disk ─────────── */

const isDir = async (p: string) => !!(await stat(p).catch(() => null))?.isDirectory();
/** a complete file: there, and not a download in progress (no .ahoy-part beside it) */
const settledFile = async (p: string) => !!(await lstat(p).catch(() => null))?.isFile() && !(await lstat(p + PART_EXT).catch(() => null));

/** every plain file under a folder, as forward-slash relative paths; links (and junctions) are never followed */
async function filesUnder(root: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(rel ? join(root, rel) : root, { withFileTypes: true }).catch(() => [])) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await filesUnder(root, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

/** a rename (same volume: instant), or a copy and delete across volumes */
async function moveFile(from: string, to: string) {
  await mkdir(dirname(to), { recursive: true });
  try { await rename(from, to); }
  catch (e: any) {
    if (e?.code !== "EXDEV") throw e;
    await copyFile(from, to);
    await unlink(from);
  }
}
/** undo moves [from, to] in reverse order, as far as it goes */
async function putBack(moved: [string, string][]) {
  for (const [from, to] of [...moved].reverse()) await moveFile(to, from).catch(() => {});
}

/** remove `dir` and its parents while they are empty, never `root` itself */
async function pruneUp(dir: string, root: string) {
  for (let d = resolve(dir); within(root, d) && fold(d) !== fold(resolve(root)); d = dirname(d)) {
    try { await rmdir(d); } catch { return; }
  }
}
/** remove the empty folders under `dir`, and `dir` when it ends up empty */
async function pruneTree(dir: string) {
  const ents = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (!ents) return;
  for (const e of ents) if (e.isDirectory()) await pruneTree(join(dir, e.name));
  await rmdir(dir).catch(() => {});
}

/** saves in progress, by file */
const saving = new Map<string, Promise<void>>();
let tmpSeq = 0;
/**
 * Write through a temporary file of its own, so neither a crash nor another save ever leaves half a list. Saves of one
 * file run one after another, so the last one asked for is what stays. Windows refuses a rename onto a file something
 * else holds for a moment (a virus scanner, a backup), so the rename is tried again for about half a second; a target
 * that stays locked falls back to a plain write.
 */
export function writeAtomic(path: string, text: string): Promise<void> {
  const key = fold(resolve(path));
  const run = (saving.get(key) ?? Promise.resolve()).then(() => writeNow(path, text));
  const settled = run.catch(() => {});
  saving.set(key, settled);
  void settled.then(() => { if (saving.get(key) === settled) saving.delete(key); });
  return run;
}
async function writeNow(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}-${++tmpSeq}.tmp`;
  try {
    // on disk before it takes the name, so a power cut never leaves the name on an empty file
    const fh = await open(tmp, "w");
    try { await fh.writeFile(text); await fh.sync(); } finally { await fh.close(); }
    for (let i = 1; ; i++) {
      try { await rename(tmp, path); break; }
      catch (e: any) {
        if (i >= 10 || !/^(EPERM|EBUSY|EACCES)$/.test(String(e?.code))) throw e;
        await new Promise(r => setTimeout(r, 10 * i));
      }
    }
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    // in place, which a crash in the middle would leave torn: so the whole text goes beside it first (see readJson)
    await writeFile(path + BAK, text).catch(() => {});
    await writeFile(path, text);
    return;
  }
  // a whole file, saved the usual way: a copy an in-place write left beside it is older
  await rm(path + BAK, { force: true }).catch(() => {});
}

/** beside a file written in place: the same text, whole */
const BAK = ".bak";
/**
 * A JSON file this launcher keeps in dataDir, as it is on disk (undefined: there is none). One something holds for a
 * moment (a virus scanner, a backup) is read again for about half a second; one that does not parse (torn by a crash in
 * the middle of writeAtomic's in-place write) is read from the whole copy that write left beside it. Anything else throws.
 */
async function readJson(file: string): Promise<unknown> {
  let text: string | null = null;
  for (let i = 1; text === null; i++) {
    try { text = await readFile(file, "utf8"); }
    catch (e: any) {
      if (e?.code === "ENOENT") return undefined;
      if (i >= 10 || !/^(EBUSY|EPERM|EACCES)$/.test(String(e?.code))) throw new Error(`${basename(file)} could not be read (${e?.code ?? e?.message ?? e})`);
      await new Promise(r => setTimeout(r, 10 * i));
    }
  }
  try { return JSON.parse(text); }
  catch {
    const copy = await readFile(file + BAK, "utf8").catch(() => null);
    if (copy !== null) { try { return JSON.parse(copy); } catch { /* neither reads */ } }
    throw new Error(`${basename(file)} could not be read (it is not whole)`);
  }
}
/** a list kept in dataDir, as an edit must read it (readJson): none yet is an empty list; anything but a list throws */
async function readList(file: string): Promise<unknown[]> {
  const j = await readJson(file);
  if (j === undefined) return [];
  if (!Array.isArray(j)) throw new Error(`${basename(file)} could not be read (it is not a list)`);
  return j;
}
const gamesOf = (list: unknown[]) => list.filter((g): g is InstalledGame => !!g && typeof g === "object" && !!(g as InstalledGame).slug && !!(g as InstalledGame).path);

/** a response's body as text, or null when it is (or says it is) longer than `max` bytes: reading stops there */
async function bodyUpTo(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) { void res.body?.cancel().catch(() => {}); return null; }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  for (let n = 0; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { void reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

const sha256File = async (path: string, onBytes?: (n: number) => void): Promise<string> => {
  const h = createHash("sha256");
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (!bytesRead) break;
      h.update(buf.subarray(0, bytesRead));
      onBytes?.(bytesRead);
    }
  } finally { await fh.close(); }
  return h.digest("hex");
};

/**
 * Does a running program hold this file (its program, a library it loaded, a file it keeps open against writing)?
 * Opening it for writing, which writes nothing, is refused then: EBUSY on Windows, ETXTBSY elsewhere. No other refusal is
 * a running game: a read-only file or a deny-write entry gives EPERM, and what an update must replace then fails at that
 * file as it always has. A file held only for a moment (a virus scanner, a backup) is asked again before it counts.
 */
async function held(file: string): Promise<boolean> {
  for (let i = 1; ; i++) {
    try { await (await open(file, "r+")).close(); return false; }
    catch (e: any) {
      if (e?.code !== "EBUSY" && e?.code !== "ETXTBSY") return false;
      if (i >= 3) return true;
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
/**
 * Is the game running: does a program hold any of these files of its folder (install-relative paths; one that is not on
 * disk is not held)? This sees a game started outside Ahoy too: from its desktop shortcut, before the launcher
 * restarted, or by a launcher of its own that has exited since, none of which the engine saw start.
 */
async function inUse(folder: string, rels: Iterable<string | undefined>): Promise<boolean> {
  for (const rel of new Set(rels)) {
    if (typeof rel !== "string" || pathProblem(rel)) continue;
    const abs = resolve(folder, rel);
    if (within(folder, abs) && (await held(abs))) return true;
  }
  return false;
}

/** a package manifest as something the pull engine can walk: paths are "<slug>/<relative path>" */
export function manifestSource(m: Manifest, filesBase: string, headers: Record<string, string> = {}): HttpSource {
  const files = new Map(m.files.map(f => [f.path, f] as [string, ManifestFile]));
  const dirs = new Map<string, Map<string, RemoteEntry>>();
  const ensureDir = (d: string) => { let e = dirs.get(d); if (!e) { e = new Map(); dirs.set(d, e); } return e; };
  ensureDir("");
  for (const f of m.files) {
    const parts = f.path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = parts.slice(0, i).join("/"), name = parts[i];
      ensureDir(parent).set(name, { name, size: 0, isDir: true });
      ensureDir(parts.slice(0, i + 1).join("/"));
    }
    ensureDir(parts.slice(0, -1).join("/")).set(parts.at(-1)!, { name: parts.at(-1)!, size: f.size, isDir: false });
  }
  const rel = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean).slice(1).join("/");
  return {
    stat: async p => {
      const r = rel(p);
      if (dirs.has(r)) return { size: 0, isDir: true };
      const f = files.get(r);
      if (!f) throw new Error(`not in the manifest: ${r}`);
      return { size: f.size, isDir: false };
    },
    list: async p => [...(dirs.get(rel(p))?.values() ?? [])].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    request: async p => ({ url: filesBase.replace(/\/?$/, "/") + rel(p).split("/").map(encodeURIComponent).join("/"), headers }),
  };
}

type Emit = (phase: Phase, progress: number, bytes: number, rate?: number, message?: string) => void;
/** which game something belongs to: a gameId on a server */
interface GameOf { gameId?: number | null; serverUrl?: string }
/**
 * Are these two different games? Only gameIds from the same server tell games apart; when either has none (a package
 * without one, a set-aside entry written before they were kept) or they come from different servers, the slug decides,
 * as it always has.
 */
const otherGame = (a: GameOf, b: GameOf) => a.gameId != null && b.gameId != null && a.serverUrl === b.serverUrl && a.gameId !== b.gameId;
/** where set-aside saves of a slug wait, and whose they are (an entry without a gameId goes back into any game of the slug) */
interface KeptEntry extends GameOf { slug: string; dir: string }
const keptOf = (list: unknown[]) => list.filter((e): e is KeptEntry => !!e && typeof (e as KeptEntry).slug === "string" && typeof (e as KeptEntry).dir === "string");
/** a set-aside folder found for a slug, and whose saves it holds ({} when nothing says) */
interface KeptDir { dir: string; owner: GameOf }
const sameDir = (a: string, b: string) => fold(resolve(a)) === fold(resolve(b));
/** may `who` take what waits in this keep folder of `slug` (or delete it): the slug's own folder unless another game's
 *  saves wait there; a second game's (.<slug>~<gameId>) only for exactly that game, never for a package without a gameId */
const mayTake = (dir: string, owner: GameOf, slug: string, who: GameOf) =>
  basename(dir) === slug ? !otherGame(owner, who) : owner.gameId != null && owner.gameId === who.gameId && owner.serverUrl === who.serverUrl;

export class Engine {
  private handles = new Map<number, PullHandle>();
  /** installs under way, by package: Cancel stops one in whatever it is doing (fetching, checking files, a prerequisite) */
  private stops = new Map<number, AbortController>();
  private running = new Map<string, number>();
  /** games Play is starting (asking the server, checking the program, spawning): a second Play meanwhile joins that start */
  private starting = new Map<string, Promise<number>>();
  /** install folders an install or an uninstall is working on: one at a time each */
  private busy = new Set<string>();
  /** the list edits so far, in order (see serial) */
  private edits: Promise<unknown> = Promise.resolve();
  constructor(private o: EngineOpts) {}

  private file() { return join(this.o.dataDir, "installed.json"); }
  private filesFile(slug: string) { return safeSlug(slug) ? join(this.o.dataDir, "installed-files", `${slug}.json`) : null; }
  private keptFile() { return join(this.o.dataDir, "kept.json"); }
  /** what is kept of a game taken as blocks: <this>.json and <this>.blk */
  private blocksFile(slug: string) { return safeSlug(slug) ? join(this.o.dataDir, "installed-blocks", slug) : null; }

  async installed(): Promise<InstalledGame[]> {
    try { return gamesOf(await readList(this.file())); } catch { return []; }
  }
  /** run `fn` once every list edit before it has finished: installed.json and kept.json are read, changed and written one
   *  edit at a time (an uninstall that takes seconds must not write back a list from before an install that finished
   *  meanwhile, nor may two installs finishing together lose one of them) */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.edits.then(fn);
    this.edits = run.catch(() => {});
    return run;
  }
  /** change installed.json: `change` gets the list as it is by then (giving the same list back leaves it as it is). A list
   *  that cannot be read is never written over, which would forget every game on it: the edit throws instead */
  private editInstalled(change: (list: InstalledGame[]) => InstalledGame[]): Promise<void> {
    return this.serial(async () => {
      let before: InstalledGame[];
      try { before = gamesOf(await readList(this.file())); }
      catch (e: any) { throw new Error(`this PC's list of games could not be read, so it was left as it is — try again (${e?.message ?? e})`); }
      const list = change(before);
      if (list === before) return;
      await writeAtomic(this.file(), JSON.stringify(list, null, 2));
      this.o.onEvent({ type: "installed-changed", installed: list });
    });
  }

  /**
   * The server is known by another address from now on and is the same server (its http address now sends on to https):
   * what this PC recorded under the old address, its games and the saves set aside from them, is recorded under the new
   * one. Play asks only the server a copy was recorded from how it starts, and saves go back only to that server's game, so
   * without this every copy would be another server's from here on. Anything recorded under a third address stays.
   */
  async serverMoved(from: string, to: string): Promise<void> {
    const bare = (u: unknown) => (typeof u === "string" ? u.replace(/\/+$/, "") : null);
    const old = bare(from), now = bare(to);
    if (!old || !now || old === now) return;
    const games = this.editInstalled(list => (list.some(g => bare(g.serverUrl) === old) ? list.map(g => (bare(g.serverUrl) === old ? { ...g, serverUrl: now } : g)) : list));
    const kept = this.serial(async () => {
      let raw: unknown[];
      try { raw = await readList(this.keptFile()); } catch { return; }
      const before = keptOf(raw);
      if (before.some(e => bare(e.serverUrl) === old)) await writeAtomic(this.keptFile(), JSON.stringify(before.map(e => (bare(e.serverUrl) === old ? { ...e, serverUrl: now } : e)), null, 2));
    });
    await kept.catch(() => {});
    await games;
  }

  /** the files a game was installed with, when they are known for exactly that package */
  private async fileList(slug: string, packageId: number): Promise<string[] | null> {
    const f = this.filesFile(slug);
    if (!f) return null;
    try {
      const j = await readJson(f) as { packageId?: unknown; files?: unknown } | undefined;
      return j && j.packageId === packageId && Array.isArray(j.files) ? j.files.filter((x): x is string => typeof x === "string") : null;
    } catch { return null; }
  }
  /**
   * The files a game was installed with, to vouch for a program: the list kept for exactly its package; "none" for a game
   * installed before 0.10.0, which kept no list (nor keep or seed globs on its record); "unknown" when the list is missing
   * for a game that kept one, does not read, or is another package's (a save that failed), which vouches for nothing.
   */
  private async installedFiles(g: InstalledGame): Promise<string[] | "none" | "unknown"> {
    const f = this.filesFile(g.slug);
    if (!f) return "unknown";
    let j: unknown;
    try { j = await readJson(f); } catch { return "unknown"; }
    if (j === undefined) return g.keep === undefined && g.seed === undefined ? "none" : "unknown";
    const x = j as { packageId?: unknown; files?: unknown } | null;
    return x && typeof x === "object" && x.packageId === g.packageId && Array.isArray(x.files) ? x.files.filter((p): p is string => typeof p === "string") : "unknown";
  }
  /**
   * What save sync needs of a game on this PC: its folder, its keep globs, the files it was installed with (null when they are
   * not known for its package), and whether it is running here or being installed or removed (its saves are then left alone).
   */
  async forSaves(slug: string): Promise<{ slug: string; path: string; keep: string[]; installed: string[] | null; gameId: number | null; name: string; busy: boolean } | null> {
    const g = (await this.installed()).find(x => x.slug === slug);
    if (!g || g.kind === "rom") return null;
    const files = await this.installedFiles(g);
    return { slug: g.slug, path: g.path, keep: g.keep ?? [], installed: Array.isArray(files) ? files : null, gameId: g.gameId, name: g.name, busy: this.running.has(slug) || this.starting.has(slug) || this.busy.has(slug) };
  }
  private async saveFileList(slug: string, packageId: number, files: string[]) {
    const f = this.filesFile(slug);
    // when this fails the list stays unknown, and the next update then deletes nothing
    if (f) await writeAtomic(f, JSON.stringify({ packageId, files })).catch(() => {});
  }

  private async keptIndex(): Promise<KeptEntry[]> {
    try { return keptOf(await readList(this.keptFile())); } catch { return []; }
  }
  /** record that `owner`'s saves of `slug` wait in `dir` ({} when nothing says whose they are), or with null that nothing
   *  waits there any more; the entries of other folders stay as they are. A list that cannot be read is left as it is,
   *  never written over with this one entry: saves set aside wait in the library's own keep folder, found without it */
  private setKept(slug: string, dir: string, owner: GameOf | null): Promise<void> {
    return this.serial(async () => {
      let raw: unknown[];
      try { raw = await readList(this.keptFile()); } catch { return; }
      const before = keptOf(raw);
      const after = before.filter(e => !(e.slug === slug && sameDir(e.dir, dir)));
      if (owner) after.push(owner.gameId != null ? { slug, dir, gameId: owner.gameId, serverUrl: owner.serverUrl } : { slug, dir });
      if (JSON.stringify(after) !== JSON.stringify(before)) await writeAtomic(this.keptFile(), JSON.stringify(after, null, 2));
    });
  }
  /** where what earlier uninstalls of a slug set aside waits, and whose it is: beside the games in `library`, and wherever
   *  the index says (the library folder setting may have changed since); only folders named <...>/.ahoy-keep/<slug>, or
   *  .<slug>~<gameId> for a second game of the slug (no slug starts with a dot, so that is never another slug's) */
  private async keptDirs(slug: string, library: string | null): Promise<KeptDir[]> {
    const cands: KeptDir[] = [
      ...(library ? [{ dir: join(library, KEEP_DIR, slug), owner: {} }] : []),
      ...(await this.keptIndex()).filter(e => e.slug === slug).map(e => ({ dir: e.dir, owner: { gameId: e.gameId, serverUrl: e.serverUrl } })),
    ];
    const out: KeptDir[] = [];
    for (const c of cands) {
      const name = basename(c.dir);
      if (basename(dirname(c.dir)) !== KEEP_DIR || (name !== slug && !(c.owner.gameId != null && name === `.${slug}~${c.owner.gameId}`))) continue;
      const seen = out.find(x => sameDir(x.dir, c.dir));
      if (!seen) out.push(c);
      else if (seen.owner.gameId == null) seen.owner = c.owner;          // the index says whose the library's folder holds
    }
    return out;
  }
  /** where an uninstall sets a game's saves aside: <library>/.ahoy-keep/<slug>, or .<slug>~<gameId> while another game's
   *  saves wait there, so two games of one slug never share a folder (nor get each other's saves back) */
  private async keepDirFor(library: string, g: InstalledGame): Promise<string> {
    const base = join(library, KEEP_DIR, g.slug);
    const there = (await this.keptDirs(g.slug, library)).find(k => sameDir(k.dir, base));
    return there && otherGame(there.owner, g) ? join(library, KEEP_DIR, `.${g.slug}~${g.gameId}`) : base;
  }

  private headers() { return { Authorization: `Bearer ${this.o.token()}` }; }
  private async fetchJson<T>(path: string): Promise<T> {
    const f = this.o.fetchImpl ?? fetch;
    const res = await f(this.o.serverUrl().replace(/\/+$/, "") + path, { headers: this.headers(), signal: AbortSignal.timeout(60_000) });
    if (res.status === 401) throw new Error("you are signed out — sign in again");
    if (!res.ok) throw new Error(`the server answered ${res.status} for ${path}`);
    return res.json() as Promise<T>;
  }

  isInstalling(packageId: number) { return this.handles.has(packageId); }

  /**
   * download + verify + prerequisites → an InstalledGame; progress goes out as events. Installing a game that is
   * already here updates it in place: the previous package's files the new one lacks are deleted (only files this
   * launcher installed, never keep or seed matches), and keep and seed matches already on disk are left as they are.
   * Refused while the game runs, and while another game is installed under the same slug.
   */
  async install(packageId: number, libraryDir: string): Promise<InstalledGame> {
    if (this.handles.has(packageId)) throw new Error("already installing");
    const { item: pkg } = await this.fetchJson<{ item: PackageInfo }>(`/api/v1/package/${packageId}`);
    const m = pkg.manifest;
    checkManifest(m, this.o.version ?? "0.0.0");
    if (this.busy.has(m.slug)) throw new Error("already installing");
    // an update would replace files under the running game (and stop half-way at the program Windows keeps locked); one
    // Play is starting is about to run
    if (this.running.has(m.slug) || this.starting.has(m.slug)) throw new Error("the game is running — close it first");
    this.busy.add(m.slug);
    const stop = new AbortController();
    this.stops.set(packageId, stop);
    try { return await this.put(packageId, pkg, m, libraryDir, stop.signal); }
    finally { this.busy.delete(m.slug); this.stops.delete(packageId); }
  }

  private async put(packageId: number, pkg: PackageInfo, m: Manifest, libraryDir: string, stop: AbortSignal): Promise<InstalledGame> {
    const kind = kindOf(m.kind);
    const keep = m.keep ?? [], seed = m.seed ?? [];
    const server = this.o.serverUrl().replace(/\/+$/, "");
    const who: GameOf = { gameId: pkg.gameId, serverUrl: server };
    const prev = (await this.installed()).find(g => g.slug === m.slug);
    // the slug is the folder's name: another game that has it (two games of one title) is refused, never updated over
    if (prev && otherGame(prev, who)) throw new Error(`another game is installed in the folder this one needs (${prev.name}) — uninstall it in Settings → On this PC first`);
    // an update goes where the game already is (its saves are there), as long as that folder is still on disk
    const here = prev && basename(prev.path) === prev.slug && (await isDir(prev.path)) ? prev : undefined;
    const library = here ? dirname(resolve(here.path)) : resolve(libraryDir);
    const dest = join(library, m.slug);
    await mkdir(library, { recursive: true });
    // a fresh install takes back what the last uninstall of this game set aside (a failed one puts it back again)
    const restored = here ? [] : await this.restoreKept(m.slug, library, dest, [...keep, ...seed], who);
    // a keep or seed match already on disk is the player's by now (a save, settings the program rewrote, a file shipped
    // once): never fetched or verified again
    const leftAlone = globMatcher([...seed, ...keep]);
    const files: ManifestFile[] = [];
    for (const f of m.files) if (!(leftAlone(f.path) && (await settledFile(join(dest, f.path))))) files.push(f);
    // an update replaces and deletes files under the game: while it runs (started by Ahoy or not) its program and what it
    // loaded are locked, and the update would stop half-way at the first of them, so nothing starts
    const stale = here && here.packageId !== packageId ? await this.staleFiles(here, m) : [];
    if (here && (await inUse(dest, [here.launch?.exe, ...files.map(f => f.path), ...stale]))) throw new Error("the game is running — close it first");
    const total = files.reduce((a, f) => a + f.size, 0);
    const emit: Emit = (phase, progress, bytes, rate = 0, message) =>
      this.o.onEvent({ type: "install", packageId, gameId: pkg.gameId, slug: m.slug, name: m.name, phase, progress, bytes, total, rate, message });
    try {
      await this.bring(packageId, pkg, m, files, total, library, dest, emit, stop);
      if (kind !== "rom" && m.prerequisites?.length) await this.prerequisites(m, dest, emit, total, stop);
      emit("finishing", 1, total);
    } catch (e) {
      await putBack(restored);
      throw e;
    }
    if (stale.length) await this.dropStale(dest, stale);
    const record: InstalledGame = {
      slug: m.slug, gameId: pkg.gameId, packageId, name: m.name, version: m.version, path: dest, launch: m.launch, kind, platform: m.platform ?? null,
      sizeBytes: m.totalSize, installedAt: Date.now(), serverUrl: server, keep, seed, shortcut: null,
    };
    await this.saveFileList(m.slug, packageId, m.files.map(f => f.path));
    record.shortcut = await this.placeShortcut(record, prev);
    // a list it cannot read is not written over (editInstalled): the install fails there, as one that cannot finish
    try { await this.editInstalled(list => [...list.filter(g => g.slug !== m.slug), record]); }
    catch (e: any) { emit("failed", 1, total, 0, String(e?.message ?? e)); throw e; }
    if (!here) await this.tidyKept(m.slug, library, who);
    emit("done", 1, total);
    return record;
  }

  /** the package's files (`files`: the ones not left alone) into dest: as blocks when the server can send it so, else file by file */
  private async bring(packageId: number, pkg: PackageInfo, m: Manifest, files: ManifestFile[], total: number, library: string, dest: string, emit: Emit, stop: AbortSignal) {
    const info = this.o.blocks === false ? null : blocksInfoOf(pkg.blocks);
    if (info && (await this.fetchBlocks(packageId, m, files, info, dest, emit, stop))) return;
    // file by file: what was kept of the folder's blocks says nothing about files written this way
    await dropBlockState(this.blocksFile(m.slug));
    await this.fetchFiles(packageId, { ...m, files, totalSize: total }, library, dest, emit, stop);
  }

  /**
   * The files as blocks (pull/blocks.ts). true: they are in place, each block checked as it arrived; false: the server
   * cannot send this package as blocks after all, and nothing is said of it (file by file follows). A failure or a cancel
   * is told and thrown, as fetchFiles does.
   */
  private async fetchBlocks(packageId: number, m: Manifest, files: ManifestFile[], info: BlocksInfo, dest: string, emit: Emit, stop: AbortSignal): Promise<boolean> {
    const server = this.o.serverUrl().replace(/\/+$/, "");
    let reading = false, last = { b: 0, at: Date.now() };
    emit("downloading", 0, 0);
    const h = startBlockPull({
      url: `${server}/api/v1/package/${packageId}/blocks`, headers: () => this.headers(), fetchImpl: this.o.fetchImpl, dest, all: m.files, files, info,
      state: this.blocksFile(m.slug), ...(this.o.blocks || {}),
      // what is on disk already is read first (an update, a download picked up again): told as checking, not as downloading
      onScan: (d, t) => {
        reading = d < t; last = { b: h.bytes(), at: Date.now() };
        emit("verifying", t ? d / t : 1, h.bytes());
        if (!reading) emit("downloading", h.progress(), h.bytes());           // read: what is missing comes now
      },
    });
    this.handles.set(packageId, h);
    if (stop.aborted) h.cancel();
    const timer = setInterval(() => {
      if (reading) return;
      const b = h.bytes(), now = Date.now();
      const rate = now > last.at ? (b - last.b) / ((now - last.at) / 1000) : 0;
      last = { b, at: now };
      emit("downloading", h.progress(), b, Math.max(0, rate));
    }, 500);
    let res: Awaited<typeof h.done>;
    try { res = await h.done; } finally { clearInterval(timer); this.handles.delete(packageId); }
    if (res.ok) return true;
    if (res.unavailable && !stop.aborted) return false;
    emit(res.error === "cancelled" || stop.aborted ? "cancelled" : "failed", 0, res.bytes, 0, stop.aborted ? "cancelled" : res.error);
    throw new Error(stop.aborted ? "cancelled" : res.error ?? "download failed");
  }

  /** pull every listed file into dest, then verify each against its sha256; anything wrong is fetched again once */
  private async fetchFiles(packageId: number, m: Manifest, library: string, dest: string, emit: Emit, stop: AbortSignal) {
    const server = this.o.serverUrl().replace(/\/+$/, "");
    const source = manifestSource(m, `${server}/api/v1/package/${packageId}/files/`, this.headers());
    const share = (n: number) => (m.totalSize > 0 ? n / m.totalSize : 1);
    /** Cancel between downloads (while files are checked) ends the install there */
    const cancelled = (bytes: number) => { if (stop.aborted) { emit("cancelled", 0, bytes, 0, "cancelled"); throw new Error("cancelled"); } };
    const pullOnce = async () => {
      const h = startHttpPull({ remotePath: m.slug, isDir: true, expectedBytes: m.totalSize }, source, { downloadsDir: library, segments: this.o.segments ?? 4, fetchImpl: this.o.fetchImpl });
      this.handles.set(packageId, h);
      if (stop.aborted) h.cancel();
      let last = { b: 0, at: Date.now() };
      const timer = setInterval(() => {
        const b = h.bytes(), now = Date.now();
        const rate = now > last.at ? (b - last.b) / ((now - last.at) / 1000) : 0;
        last = { b, at: now };
        emit("downloading", h.progress(), b, Math.max(0, rate));
      }, 500);
      try { return await h.done; } finally { clearInterval(timer); this.handles.delete(packageId); }
    };

    emit("downloading", 0, 0);
    let res = await pullOnce();
    if (!res.ok) { emit(res.error === "cancelled" ? "cancelled" : "failed", 0, res.bytes, 0, res.error); throw new Error(res.error ?? "download failed"); }

    for (let round = 0; round < 2; round++) {
      let done = 0, lastEmit = 0;
      const bad: string[] = [];
      for (const f of m.files) {
        cancelled(done);
        const p = join(dest, f.path);
        const st = await stat(p).catch(() => null);
        const hash = st && st.size === f.size ? await sha256File(p, n => { done += n; if (Date.now() - lastEmit > 300) { lastEmit = Date.now(); emit("verifying", share(done), done); } }) : null;
        if (hash !== f.sha256) { bad.push(f.path); await rm(p, { force: true }); await rm(p + PART_EXT, { force: true }); }
      }
      cancelled(done);
      emit("verifying", 1, m.totalSize);
      if (!bad.length) break;
      if (round === 1) { emit("failed", 1, m.totalSize, 0, `${bad.length} file(s) did not verify: ${bad.slice(0, 3).join(", ")}`); throw new Error(`verification failed for ${bad.length} file(s)`); }
      res = await pullOnce();
      if (!res.ok) { emit(res.error === "cancelled" ? "cancelled" : "failed", 0, res.bytes, 0, res.error); throw new Error(res.error ?? "download failed"); }
    }
  }

  /**
   * The package's redistributables, hidden; a failure is reported and the install goes on. One that outlasts its time
   * (it waits for an answer, and its window is hidden) is stopped and counts as a failure; Cancel stops the one running
   * and ends the install.
   */
  private async prerequisites(m: Manifest, dest: string, emit: Emit, total: number, stop: AbortSignal) {
    const cancelled = () => { if (stop.aborted) { emit("cancelled", 0, total, 0, "cancelled"); throw new Error("cancelled"); } };
    cancelled();
    emit("prerequisites", 1, total, 0, `installing ${m.prerequisites.length} prerequisite(s)`);
    for (const p of m.prerequisites) {
      const exe = join(dest, p.path);
      // this installer's own stop: Cancel, or its time running out
      const end = new AbortController();
      const onStop = () => end.abort();
      stop.addEventListener("abort", onStop);
      let late = false;
      const timer = setTimeout(() => { late = true; end.abort(); }, this.o.installerMaxMs ?? INSTALLER_MAX_MS);
      try {
        const run = (this.o.runInstaller ?? defaultRunInstaller)(exe, String(p.args ?? "").split(" ").filter(Boolean), dirname(exe), end.signal);
        run.catch(() => {});                              // one that fails after it was given up on is nobody's error
        const gone = new Promise<never>((_, rej) => end.signal.addEventListener("abort", () => rej(new Error(late ? "took too long, stopped" : "cancelled")), { once: true }));
        const code = await Promise.race([run, gone]);
        if (code !== 0) emit("prerequisites", 1, total, 0, `${p.kind} installer exited ${code} (continuing)`);
      } catch (e: any) {
        cancelled();
        emit("prerequisites", 1, total, 0, `${p.kind}: ${e?.message ?? e} (continuing)`);
      } finally { clearTimeout(timer); stop.removeEventListener("abort", onStop); }
      cancelled();
    }
  }

  /**
   * What an update deletes: the previous package's files the new one lacks. Only files on the list this launcher recorded
   * for that package (a game installed before 0.10.0 has none, so nothing goes), never a keep or seed match of either
   * package.
   */
  private async staleFiles(prev: InstalledGame, m: Manifest): Promise<string[]> {
    const old = await this.fileList(prev.slug, prev.packageId);
    if (!old) return [];
    const key = (p: string) => p.replace(/\\/g, "/").toLowerCase();       // on Windows a file in another case is the same file
    const now = new Set(m.files.map(f => key(f.path)));
    const spared = globMatcher([...(prev.keep ?? []), ...(prev.seed ?? []), ...(m.keep ?? []), ...(m.seed ?? [])]);
    return old.filter(rel => !now.has(key(rel)) && !spared(rel) && !pathProblem(rel));
  }
  /** after an update: delete those files, never through a link that leads out of the folder; folders this leaves empty go too */
  private async dropStale(dest: string, stale: string[]) {
    const emptied = new Set<string>();
    for (const rel of stale) {
      const abs = join(dest, rel);
      if (!within(dest, abs) || !(await realWithin(dest, dirname(abs)))) continue;
      if (!(await lstat(abs).catch(() => null))?.isFile()) continue;
      await rm(abs, { force: true }).catch(() => {});
      await rm(abs + PART_EXT, { force: true }).catch(() => {});
      emptied.add(dirname(abs));
    }
    for (const d of [...emptied].sort((a, b) => b.length - a.length)) await pruneUp(d, dest);
  }

  /** move what earlier uninstalls of this game set aside into a fresh install: the files the new package keeps or seeds,
   *  never over a file already there, never another game's; returns the moves so a failed install can undo them */
  private async restoreKept(slug: string, library: string, dest: string, globs: string[], who: GameOf): Promise<[string, string][]> {
    const wanted = globMatcher(globs);
    const moved: [string, string][] = [];
    for (const { dir, owner } of await this.keptDirs(slug, library)) {
      if (!mayTake(dir, owner, slug, who)) continue;
      for (const rel of await filesUnder(dir)) {
        const from = join(dir, rel), to = join(dest, rel);
        if (!wanted(rel) || pathProblem(rel) || !within(dest, to) || (await lstat(to).catch(() => null))) continue;
        try { await moveFile(from, to); moved.push([from, to]); } catch { /* it stays set aside */ }
      }
    }
    return moved;
  }
  /** after a good fresh install: drop the keep folders of this game it emptied, with their index entries; one that still
   *  holds something stays recorded, so an install into another library folder finds it too */
  private async tidyKept(slug: string, library: string, who: GameOf) {
    for (const { dir, owner } of await this.keptDirs(slug, library)) {
      if (!mayTake(dir, owner, slug, who)) continue;
      await pruneTree(dir);
      if (await isDir(dir)) { await this.setKept(slug, dir, owner); continue; }
      await rmdir(dirname(dir)).catch(() => {});                          // .ahoy-keep itself, once nothing else waits
      await this.setKept(slug, dir, null);
    }
  }

  /** move the keep matches among the install folder's files (rels) into keepDir; undone when one cannot move */
  private async setAside(folder: string, rels: string[], keep: string[], keepDir: string): Promise<[string, string][]> {
    const isKept = globMatcher(keep);
    const moved: [string, string][] = [];
    try {
      for (const rel of rels) {
        if (!isKept(rel)) continue;
        await moveFile(join(folder, rel), join(keepDir, rel));
        moved.push([join(folder, rel), join(keepDir, rel)]);
      }
    } catch (e: any) {
      await putBack(moved);
      throw new Error(`a saved game could not be set aside (${e?.code ?? e?.message ?? e}), so nothing was removed — close anything using the game's folder and try again`);
    }
    return moved;
  }

  /** does this shortcut start something inside one of these folders (only then is it this launcher's) */
  private startsInside(file: string, folders: string[]): boolean {
    let target: string | null = null;
    try { target = this.o.shortcuts?.read(file) ?? null; } catch { target = null; }
    return typeof target === "string" && isAbsolute(target) && folders.some(f => within(f, target!));
  }

  /**
   * The desktop shortcut for a game just installed. A shortcut is this launcher's only while it starts something inside
   * the game's folder: the one recorded with the game or, for a game installed before 0.10.0 (its record has no shortcut
   * at all), the one of the game's name. That one is rewritten when the setting is on and a shortcut can start the game,
   * and removed when not; with none, one is made under the game's name when nothing has that name. Any other shortcut
   * (the person's own, a store's, theirs put in place of this launcher's, one they made while the record says this
   * launcher made none) is never touched, and one the person deleted is not made again: its path stays recorded, so
   * later updates know.
   */
  private async placeShortcut(g: InstalledGame, prev: InstalledGame | undefined): Promise<string | null> {
    const s = this.o.shortcuts;
    if (!s) return null;
    const there = async (f: string) => !!(await lstat(f).catch(() => null));
    const recorded = prev?.shortcut && /\.lnk$/i.test(prev.shortcut) ? prev.shortcut : null;
    if (recorded && !(await there(recorded))) return recorded;
    const named = join(s.dir(), shortcutName(g.name));
    // from 0.10.0 on a record says which shortcut this launcher made (null: none), so one of the game's name can be the
    // launcher's only for a record from before (0.9.0 made it and recorded nothing)
    const found = recorded ?? (prev && prev.shortcut === undefined && (await there(named)) ? named : null);
    const ours = found && this.startsInside(found, prev ? [g.path, prev.path] : [g.path]) ? found : null;
    const link = s.enabled() ? shortcutFor(g) : null;
    if (!link) { if (ours) await rm(ours, { force: true }).catch(() => {}); return null; }
    const file = ours ?? named;
    if (!ours && (await there(file))) return null;
    let ok = false;
    try { ok = s.write(file, { ...link, description: `${g.name} — Ahoy` }); } catch { ok = false; }
    if (ok) return file;
    return ours && (await there(ours)) ? ours : null;
  }

  /** stop an install wherever it is: the download, the check of its files, a prerequisite's installer */
  cancel(packageId: number) { this.stops.get(packageId)?.abort(); this.handles.get(packageId)?.cancel(); }

  /**
   * Remove a game from this PC. Its saves (the manifest's keep globs) are set aside in <library>/.ahoy-keep/<slug>/ for
   * the next install of the game, unless deleteSaves, which wipes them and anything it set aside before (never another
   * game's). Only this launcher's shortcut for it goes with it (one that starts something inside its folder), and only a
   * folder this launcher made (<library>/<slug>) is ever deleted. Refused while the game runs, also one started outside
   * Ahoy (a program holds its files).
   */
  async uninstall(slug: string, opts: { deleteSaves?: boolean } = {}): Promise<void> {
    if (this.busy.has(slug)) throw new Error("it is being installed — wait for that or cancel it");
    if (this.running.has(slug) || this.starting.has(slug)) throw new Error("the game is running — close it first");
    this.busy.add(slug);
    try {
      const g = (await this.installed()).find(x => x.slug === slug);
      const folder = g && safeSlug(g.slug) && basename(g.path) === g.slug ? resolve(g.path) : null;
      const library = folder ? dirname(folder) : null;
      if (g && folder && library) {
        const rels = await filesUnder(folder);
        // a game started outside Ahoy (from its desktop shortcut, or before the launcher restarted) holds its program and
        // what it loaded: deleting the folder would stop half-way and leave the game half gone
        if (await inUse(folder, [g.launch?.exe, ...rels])) throw new Error("the game is running — close it first");
        const keepDir = await this.keepDirFor(library, g);
        const moved = !opts.deleteSaves && g.keep?.length ? await this.setAside(folder, rels, g.keep, keepDir) : [];
        try { await rm(folder, { recursive: true, force: true }); }
        catch (e) { await putBack(moved); throw e; }
        if (moved.length) await this.setKept(g.slug, keepDir, g);
      }
      // the recorded shortcut or, for a game installed before 0.10.0 (which recorded none), the one of the game's name:
      // only while it starts the game's own files
      const s = this.o.shortcuts;
      if (g && s) {
        const lnk = g.shortcut && /\.lnk$/i.test(g.shortcut) ? g.shortcut : g.shortcut === undefined ? join(s.dir(), shortcutName(g.name)) : null;
        if (lnk && (await lstat(lnk).catch(() => null)) && this.startsInside(lnk, [g.path])) await rm(lnk, { force: true }).catch(() => {});
      }
      if (opts.deleteSaves && safeSlug(slug)) {
        for (const { dir, owner } of await this.keptDirs(slug, library)) {
          if (g && !mayTake(dir, owner, slug, g)) continue;             // another game's saves of the slug stay
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          await rmdir(dirname(dir)).catch(() => {});
          await this.setKept(slug, dir, null);
        }
      }
      const fl = this.filesFile(slug);
      if (fl) for (const f of [fl, fl + BAK]) await rm(f, { force: true }).catch(() => {});
      await dropBlockState(this.blocksFile(slug));
      await this.editInstalled(list => list.filter(x => x.slug !== slug));
    } finally { this.busy.delete(slug); }
  }

  isRunning(slug: string) { return this.running.has(slug); }

  /**
   * Launch the game detached (never through a shell); `play` events report start / exit. The server's word on how it
   * starts comes first (freshLaunch), so a start the admin corrected reaches this PC at its next Play. A second Play while
   * one is starting joins it, so two quick Plays start the game once.
   */
  async play(slug: string): Promise<number> {
    const under = this.starting.get(slug);
    if (under) return under;
    if (this.running.has(slug)) throw new Error("already running");
    // an update or an uninstall is replacing or deleting its files: the game would start on half of them, and hold files
    // that work then stops at
    if (this.busy.has(slug)) throw new Error("it is being installed or removed — wait for that");
    const run = this.start(slug);
    this.starting.set(slug, run);
    try { return await run; } finally { if (this.starting.get(slug) === run) this.starting.delete(slug); }
  }

  private async start(slug: string): Promise<number> {
    let g = (await this.installed()).find(x => x.slug === slug);
    if (!g) throw new Error("not installed");
    if (g.kind === "rom") throw new Error(`a ${g.platform ?? "console"} dump: nothing a PC can launch — an emulator has to open ${g.launch.exe}`);
    g = await this.freshLaunch(g);
    const c = launchCommand(g);
    if (!(await stat(c.file).catch(() => null))) throw new Error(`missing executable: ${g.launch.exe}`);
    const run: SpawnGame = this.o.spawnGame ?? ((exe, args, opts) => spawn(exe, args, opts));
    // a script's command line reaches the command shell as it is written here (launchCommand): never quoted again
    const child = run(c.exe, c.args, { cwd: c.cwd, detached: true, stdio: "ignore", windowsHide: false, ...(c.env ? { env: c.env } : {}), ...(c.script ? { windowsVerbatimArguments: true } : {}) });
    const pid = child.pid ?? 0;
    this.running.set(slug, pid);
    this.o.onEvent({ type: "play", slug, running: true, pid });
    const ended = (code: number | null) => { if (this.running.get(slug) === pid) this.running.delete(slug); this.o.onEvent({ type: "play", slug, running: false, pid, code }); };
    child.on("exit", code => { if (c.script) void this.afterScript(g, slug, pid).then(() => ended(code), () => ended(code)); else ended(code); });
    child.on("error", e => { this.running.delete(slug); this.o.onEvent({ type: "play", slug, running: false, pid, message: e.message }); });
    child.unref();
    return pid;
  }

  /**
   * A game's start script has ended. It may have handed the game on: to a program it started, or to itself with
   * administrator rights (it then exits at once, and the player first has to allow the other). So the game still counts as
   * running — Play is not offered twice, nothing is updated under it — while a program holds one of the game's programs;
   * it resolves once none has for two looks in a row, or when none ever appeared in time.
   */
  private async afterScript(g: InstalledGame, slug: string, pid: number): Promise<void> {
    const every = this.o.scriptWatchMs ?? SCRIPT_WATCH_MS, wait = this.o.scriptHandoverMs ?? SCRIPT_HANDOVER_MS;
    const listed = await this.installedFiles(g).catch(() => "unknown" as const);
    const programs = (Array.isArray(listed) ? listed : await filesUnder(g.path).catch(() => [] as string[])).filter(f => /\.exe$/i.test(f)).slice(0, 300);
    const since = Date.now();
    let seen = false, quiet = 0;
    while (this.running.get(slug) === pid) {
      if (await inUse(g.path, programs).catch(() => false)) { seen = true; quiet = 0; }
      else if (seen) { if (++quiet >= 2) return; }
      else if (Date.now() - since >= wait) return;
      await new Promise(r => { const t = setTimeout(r, every); (t as { unref?: () => void }).unref?.(); });
    }
  }

  /**
   * The game's record with the server's current start, when that changed and this PC may follow it (takeable): Play starts
   * it, and the record is saved with it once the desktop shortcut this launcher made has followed (followShortcut; until
   * then the next Play takes the change again). A changed start it must not follow is noted on the record (noteSkipped), for
   * the page to offer Update. Otherwise (nothing asked, no answer, the same start) the record as it is, so Play starts what it
   * always would. Nothing is downloaded or verified.
   */
  private async freshLaunch(g: InstalledGame): Promise<InstalledGame> {
    const said = await this.askLaunch(g).catch(() => null);
    if (!said) return g;
    const launch = serverStart(said);
    if (launch && launchKey(launch) === launchKey(g.launch)) return g;
    if (!launch || !(await this.takeable(g, said, launch).catch(() => false))) {
      await this.noteSkipped(g, launch ? launch.rev : said.rev).catch(() => {});
      return g;
    }
    const next: InstalledGame = { ...unnoted(g), launch };
    const followed = await this.followShortcut(g, next).catch(() => null);
    if (!followed) return next;
    const moved = followed.shortcut !== g.shortcut ? { shortcut: followed.shortcut } : {};
    const same = (x: InstalledGame) => x.slug === g.slug && x.packageId === g.packageId;
    // a list that cannot be read now is left as it is: this Play starts the change all the same, the next one saves it
    await this.editInstalled(list => (list.some(same) ? list.map(x => (same(x) ? { ...unnoted(x), launch, ...moved } : x)) : list)).catch(() => {});
    return { ...next, ...moved };
  }

  /** note on the record that Play did not take the server's start of this stamp, so the page offers Update for it; a start
   *  without a stamp gives the page nothing to compare, and one noted already changes nothing */
  private async noteSkipped(g: InstalledGame, rev: unknown): Promise<void> {
    const stamp = stampOf(rev);
    if (stamp === null || String(g.skippedRev ?? "") === String(stamp)) return;
    const same = (x: InstalledGame) => x.slug === g.slug && x.packageId === g.packageId;
    await this.editInstalled(list => (list.some(same) ? list.map(x => (same(x) ? { ...x, skippedRev: stamp } : x)) : list));
  }

  /**
   * The server's word on how the game's package starts now, or null. Nothing is asked for a game being installed or
   * removed, without a session, or for a game recorded from another server address; an error (the package replaced or
   * gone, which is an update; signed out; a server that does not know the question), no answer within launchAskMs, an
   * answer over LAUNCH_ANSWER_MAX (it stops reading there), or one that is not an answer gives null too.
   */
  private async askLaunch(g: InstalledGame): Promise<LaunchInfo | null> {
    const server = this.o.serverUrl().replace(/\/+$/, "");
    if (!server || !this.o.token() || this.busy.has(g.slug)) return null;
    if (typeof g.serverUrl !== "string" || g.serverUrl.replace(/\/+$/, "") !== server) return null;
    if (!Number.isSafeInteger(g.packageId) || g.packageId <= 0) return null;
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(done => { timer = setTimeout(() => { ctl.abort(); done(null); }, this.o.launchAskMs ?? LAUNCH_ASK_MS); });
    const ask = (async (): Promise<LaunchInfo | null> => {
      const res = await (this.o.fetchImpl ?? fetch)(`${server}/api/v1/package/${g.packageId}/launch`, { headers: this.headers(), signal: ctl.signal });
      if (!res.ok) { void res.body?.cancel().catch(() => {}); return null; }
      const text = await bodyUpTo(res, LAUNCH_ANSWER_MAX);
      if (text === null) return null;
      const j: unknown = JSON.parse(text);
      return j && typeof j === "object" && !Array.isArray(j) ? (j as LaunchInfo) : null;
    })().catch(() => null);
    try { return await Promise.race([ask, late]); } finally { clearTimeout(timer); }
  }

  /**
   * May this PC follow the start the server gave (serverStart), as an install would? It has the shape this launcher knows
   * (no field a newer launcher would read; a stamp, arguments and a command line within what Windows takes), needs no newer
   * launcher and is no console dump's. Its program is a program (.exe on Windows) inside the game's folder: a plain file on
   * disk there, one this launcher installed for that package (as the list kept for it says; a game installed before 0.10.0
   * kept none), never the player's own (a keep or seed match). Its working folder is a folder there, not a link out of it.
   */
  private async takeable(g: InstalledGame, said: LaunchInfo, launch: Launch): Promise<boolean> {
    if (Object.keys(launch).some(k => !LAUNCH_KEYS.has(k))) return false;
    if (said.kind === "rom" || !meetsRequires(said.requires, this.o.version ?? "0.0.0")) return false;
    try { checkLaunch(launch); } catch { return false; }
    if ((launch.rev != null && stampOf(launch.rev) === null) || launch.args.length > ARGS_MAX) return false;
    if (onWindows && !/\.(exe|bat|cmd)$/i.test(launch.exe)) return false;
    let c: LaunchCommand;
    try { c = launchCommand({ path: g.path, launch }); } catch { return false; }
    if ([c.exe, ...c.args].map(quoteArg).join(" ").length > COMMAND_LINE_MAX) return false;
    if (Object.entries(c.script ? c.env ?? {} : launch.env ?? {}).some(([k, v]) => k.length + 1 + String(v).length > COMMAND_LINE_MAX)) return false;
    if (!(await lstat(c.file).catch(() => null))?.isFile() || !(await realWithin(g.path, c.file))) return false;
    if (!(await isDir(c.cwd)) || !(await realWithin(g.path, c.cwd))) return false;
    const rel = launch.exe.replace(/\\/g, "/");
    if (globMatcher([...(g.keep ?? []), ...(g.seed ?? [])])(rel)) return false;
    const files = await this.installedFiles(g);
    const mine = Array.isArray(files) && files.some(f => fold(f.replace(/\\/g, "/")) === fold(rel));
    // a script is followed only when this launcher installed it with the package (a game from before the lists has none)
    return c.script ? mine : files === "none" || mine;
  }

  /**
   * After Play took a changed start, the desktop shortcut this launcher made for the game follows it: the shortcut its
   * record names (or, for a game installed before 0.10.0, the one of its name), while that still starts something inside the
   * game's folder. It is rewritten while the person's setting is on; it is removed while the setting is off, or when a
   * shortcut can no longer start the game (it needs its own environment now, or arguments too long for a shortcut), as an
   * update removes it: a shortcut that starts the old program would be worse than none. Play never makes a shortcut, and
   * never touches one this launcher did not make or one the person deleted. Gives what the record says after, or null when
   * the shortcut could not follow (the record then keeps its start, so the next Play tries again).
   */
  private async followShortcut(prev: InstalledGame, next: InstalledGame): Promise<{ shortcut: string | null | undefined } | null> {
    const s = this.o.shortcuts;
    const same = { shortcut: prev.shortcut };
    if (!s) return same;
    const link = shortcutFor(next);
    if (JSON.stringify(link) === JSON.stringify(shortcutFor(prev))) return same;                // it starts the same as before
    const file = prev.shortcut && /\.lnk$/i.test(prev.shortcut) ? prev.shortcut : prev.shortcut === undefined ? join(s.dir(), shortcutName(prev.name)) : null;
    if (!file || !(await lstat(file).catch(() => null)) || !this.startsInside(file, [prev.path])) return same;
    if (!link || !s.enabled()) {
      await rm(file, { force: true }).catch(() => {});
      return (await lstat(file).catch(() => null)) ? null : { shortcut: null };
    }
    let ok = false;
    try { ok = s.write(file, { ...link, description: `${next.name} — Ahoy` }); } catch { ok = false; }
    return ok ? { shortcut: file } : null;
  }
}

const defaultRunInstaller = (exe: string, args: string[], cwd: string, signal?: AbortSignal) => new Promise<number>((res, rej) => {
  const c = spawn(exe, args, { cwd, stdio: "ignore", windowsHide: true });
  const kill = () => { try { c.kill(); } catch { /* gone already */ } };
  // given up on (Cancel, or its time ran out): it is ended, not left waiting behind a hidden window. On Windows with
  // everything it started: an installer that unpacks itself runs the real setup as a program of its own and waits for it,
  // and ending only the wrapper would leave that one behind, hidden, while the next installer starts
  const end = () => {
    if (c.exitCode !== null || c.signalCode !== null) return;       // ended by itself meanwhile: its number may be another program's by now
    if (!onWindows || !c.pid) return kill();
    const tree = spawn(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(c.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    tree.on("error", kill);
    tree.on("exit", code => { if (code !== 0) kill(); });
  };
  if (signal?.aborted) end(); else signal?.addEventListener("abort", end, { once: true });
  c.on("exit", code => { signal?.removeEventListener("abort", end); res(code ?? -1); });
  c.on("error", rej);
});

export const isAbs = isAbsolute;
export const joinPosix = posix.join;
