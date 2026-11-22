/**
 * Ahoy launcher — a game's saves on this PC: found, packed for the server, and put back from it (save sync).
 *
 * Where a game keeps its saves is said by rules (the server's: ahoy/server/src/saverules.ts): paths that start at a place
 * of this PC,
 *   <base> the game's install folder · <home> · <winAppData> · <winLocalAppData> · <winDocuments> · <winPublic> ·
 *   <winProgramData>, and <osUserName> inside a path,
 * with * and ? inside a name and ** for any folders; a folder stands for everything in it. To them come the package's own
 * keep globs (its saves inside its folder), and, when the rules say so (`made`: a game nobody has rules for), the files the
 * game made inside its folder since it was installed.
 *
 * A file is named by its place and its path under it ("<winDocuments>/Saved Games/Hades/Profile1.sav"), so it is the same
 * file on every PC wherever Windows keeps Documents there. The digest of a set of saves is taken over those names (letter
 * case aside), the sizes and the contents: two PCs with the same saves get the same digest, whenever each wrote them.
 *
 * What is never taken or written, whatever the rules say: a path outside its place or through a link; a program, script or
 * shortcut (DENIED); what browsers, password and key stores keep (PRIVATE); a file of the game's own package (a save is not
 * what the game was installed with, unless its keep globs say so); more than FILES_MAX files or TOTAL_MAX bytes (then the
 * game's saves are not synced at all, and the answer says so).
 *
 * A version (pack) is one file: every save deflated one after the other, then the list (JSON: each file's name, size, time
 * and sha256, and its length in the pack), the list's length, and the mark AHOYSAV1 at both ends. Putting one back (restore)
 * checks every file against the list before anything on this PC changes, copies what it is about to replace into
 * <dataDir>/save-backups/<game>/<when>/ (the last BACKUPS stay), then replaces. A save this PC and the server agreed on last
 * time that the version no longer has is removed too (it was deleted on the other PC); nothing else is ever removed.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, utimes, type FileHandle } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createDeflateRaw, createInflateRaw } from "node:zlib";
import { globMatcher, pathProblem, within, writeAtomic } from "./engine";

export const PLACES = ["base", "home", "winAppData", "winLocalAppData", "winDocuments", "winPublic", "winProgramData"] as const;
export type Place = typeof PLACES[number];
/** where each place is on this PC (base: the game's install folder), and the Windows account's name */
export type Places = Partial<Record<Place, string | null>> & { osUserName?: string };
export interface Rules { paths: string[]; exclude: string[]; made: boolean }
/** a save on this PC: its name for every PC, where it is here, its size and when it was last written (ms) */
export interface Found { p: string; abs: string; size: number; mtime: number }
/** a save in a version's list: z is its deflated length in the pack */
export interface Entry { p: string; s: number; m: number; h: string; z: number }

export const MARK = "AHOYSAV1";
export const FILES_MAX = 5000, FILE_MAX = 256 * 1024 * 1024, TOTAL_MAX = 480 * 1024 * 1024;
/** what a game made in its own folder counts as saves only while it is this little: more is content, not progress */
export const MADE_FILES_MAX = 500, MADE_FILE_MAX = 32 * 1024 * 1024, MADE_TOTAL_MAX = 128 * 1024 * 1024;
export const BACKUPS = 5;
const DEPTH_MAX = 16;
/** never a save: what Windows runs or opens as a program, script or shortcut */
export const DENIED = new Set(["exe", "dll", "com", "scr", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "msi", "msp", "lnk", "url", "pif", "hta", "cpl", "sys", "drv", "ocx", "jar", "reg", "inf", "scf"]);
/** never a save, wherever a rule points: what browsers, password and key stores keep */
const PRIVATE = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker)(\/|$)|\/microsoft\/(credentials|protect|crypto|vault|windows\/start menu)(\/|$)|\/(google\/chrome|microsoft\/edge|mozilla\/firefox|bravesoftware|opera software|vivaldi)(\/|$)|\/(1password|bitwarden|keepass[^/]*|lastpass)(\/|$)/i;
/** in a game's own folder: what it makes that is no progress (logs, crash dumps, caches) */
const MADE_SKIP = globMatcher(["**/*.log", "**/*.dmp", "**/*.mdmp", "**/*.tmp", "**/*.temp", "**/*.pid", "**/*.lock", "**/*.dxvk-cache", "**/*.old", "**/logs/**", "**/log/**", "**/crashes/**", "**/crash/**", "**/crashreports/**",
  "**/crashreportclient/**", "**/shadercache/**", "**/shader_cache/**", "**/shaders/cache/**", "**/cache/**", "**/caches/**", "**/gpucache/**", "**/code cache/**", "**/webcache/**", "**/blob_storage/**", "**/__pycache__/**",
  "**/temp/**", "**/tmp/**", "**/dumps/**", "**/screenshots/**", "**/achievement_images/**", "output_log.txt", "**/output_log.txt", "player.log", "**/player.log", "player-prev.log", "**/player-prev.log", "**/unins*.dat", "**/unins*.msg"]);

export class SaveError extends Error { constructor(msg: string, public code: "too-big" | "bad" | "busy" | "server" | "gone" = "bad") { super(msg); } }

/* ─────────── rules ─────────── */

/** a rule's place and the names after it, or null when it is no rule (the same test the server makes: saverules.ts rulePath) */
export function ruleParts(raw: unknown): { place: Place; segs: string[] } | null {
  if (typeof raw !== "string" || !raw || raw.length > 300) return null;
  const m = /^<([A-Za-z]+)>\/(.+)$/.exec(raw);
  if (!m || !(PLACES as readonly string[]).includes(m[1]!)) return null;
  const segs = m[2]!.split("/");
  if (segs.some(s => !s || /^[. ]+$/.test(s))) return null;
  if (segs.some(s => /[<>:"|\\\u0000-\u001f[\]{}]/.test(s.replace(/<osUserName>/g, "")))) return null;
  if (segs.some(s => s.includes("**") && s !== "**")) return null;
  if (!segs.some(s => /[^*?]/.test(s))) return null;
  return { place: m[1] as Place, segs };
}
/** the rules a page handed over, as far as they are rules: anything else in them is dropped */
export function rulesOf(raw: unknown): Rules {
  const r = (raw && typeof raw === "object" ? raw : {}) as { paths?: unknown; exclude?: unknown; made?: unknown };
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : []);
  return { paths: strings(r.paths, 300).filter(p => !!ruleParts(p)), exclude: strings(r.exclude, 50).filter(g => pathProblem(g, { glob: true }) === null), made: r.made === true };
}
const ext = (p: string) => { const name = p.slice(p.lastIndexOf("/") + 1), dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""; };
/** may a file of this name be a save at all */
export const takeable = (p: string) => !DENIED.has(ext(p)) && !PRIVATE.test(p) && !/\.ahoy-new$/i.test(p);
/** one name of a rule as a pattern: * and ? as they read, <osUserName> any name (a save's name keeps it as written) */
const segSource = (seg: string) => seg.split(/(<osUserName>|\*+|\?)/).map(t => (t === "<osUserName>" || /^\*+$/.test(t) ? "[^/]*" : t === "?" ? "[^/]" : t.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("");
const segRe = (seg: string) => new RegExp("^" + segSource(seg) + "$", "i");

/* ─────────── finding ─────────── */

interface Walk { out: Map<string, Found>; count: number; max: number }
const tooMany = () => new SaveError("there are too many save files to keep in step", "too-big");

/** every file under a folder (never through a link) */
async function tree(dir: string, name: string, w: Walk, depth: number): Promise<void> {
  if (depth > DEPTH_MAX) return;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isSymbolicLink()) continue;
    const abs = join(dir, e.name), p = `${name}/${e.name}`;
    if (e.isDirectory()) await tree(abs, p, w, depth + 1);
    else if (e.isFile()) await file(abs, p, w);
  }
}
async function file(abs: string, p: string, w: Walk): Promise<void> {
  const key = p.toLowerCase();
  if (w.out.has(key) || !takeable(p)) return;
  const s = await lstat(abs).catch(() => null);
  if (!s?.isFile()) return;
  if (++w.count > w.max) throw tooMany();
  w.out.set(key, { p, abs, size: s.size, mtime: Math.round(s.mtimeMs) });
}
/** what one rule finds: its names walked one by one from the place (a literal name as the rule writes it, a wildcard as the
 *  disk has it), a folder at its end standing for everything in it */
async function walk(dir: string, name: string, segs: string[], i: number, user: string, w: Walk, depth: number): Promise<void> {
  if (depth > DEPTH_MAX) return;
  if (i === segs.length) {
    const s = await lstat(dir).catch(() => null);
    if (!s || s.isSymbolicLink()) return;
    if (s.isDirectory()) await tree(dir, name, w, depth); else if (s.isFile()) await file(dir, name, w);
    return;
  }
  // the save's name keeps <osUserName> as the rule writes it (the account is called something else on another PC)
  const written = segs[i]!, seg = written.replace(/<osUserName>/g, user);
  if (seg === "**") {
    await walk(dir, name, segs, i + 1, user, w, depth);
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && !e.isSymbolicLink()) await walk(join(dir, e.name), `${name}/${e.name}`, segs, i, user, w, depth + 1);
    return;
  }
  if (/[*?]/.test(seg)) {
    const re = segRe(seg);
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (!e.isSymbolicLink() && re.test(e.name)) await walk(join(dir, e.name), `${name}/${e.name}`, segs, i + 1, user, w, depth + 1);
    return;
  }
  // a literal name: on the way down it must be a real folder, never a link out of the place
  const next = join(dir, seg);
  if (i < segs.length - 1) { const s = await lstat(next).catch(() => null); if (!s?.isDirectory() || s.isSymbolicLink()) return; }
  await walk(next, `${name}/${written}`, segs, i + 1, user, w, depth + 1);
}

/** the files of the game's folder that `want` picks (by their path inside it), without looking at any other: a game's folder
 *  can hold a hundred thousand files, and only what may be a save is worth a look */
async function baseFiles(dir: string, rel: string, want: (rel: string) => boolean, out: Found[], depth = 0): Promise<void> {
  if (depth > DEPTH_MAX) return;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isSymbolicLink()) continue;
    const abs = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) await baseFiles(abs, r, want, out, depth + 1);
    else if (e.isFile() && want(r) && takeable(`<base>/${r}`)) {
      const s = await lstat(abs).catch(() => null);
      if (s?.isFile()) out.push({ p: `<base>/${r}`, abs, size: s.size, mtime: Math.round(s.mtimeMs) });
    }
  }
}

export interface ScanOpts {
  /** the package's keep globs (saves inside the game's folder) */
  keep?: readonly string[];
  /** the files the game was installed with (paths inside its folder), when they are known */
  installed?: readonly string[] | null;
  /** other limits than the module's (tests) */
  limits?: Partial<{ files: number; file: number; total: number; madeFiles: number; madeFile: number; madeTotal: number }>;
}
export interface Scan { files: Found[]; bytes: number; newest: number | null; tooBig: boolean; where: string[] }

/** a game's saves on this PC, by its rules. tooBig: there is more than is kept in step (then `files` is empty) */
export async function scan(rules: Rules, places: Places, o: ScanOpts = {}): Promise<Scan> {
  const L = { files: FILES_MAX, file: FILE_MAX, total: TOTAL_MAX, madeFiles: MADE_FILES_MAX, madeFile: MADE_FILE_MAX, madeTotal: MADE_TOTAL_MAX, ...(o.limits ?? {}) };
  const w: Walk = { out: new Map(), count: 0, max: L.files };
  const user = places.osUserName || "";
  const where = new Set<string>();
  const none: Scan = { files: [], bytes: 0, newest: null, tooBig: true, where: [] };
  const base = places.base || null;
  const shipped = new Set((o.installed ?? []).map(f => f.replace(/\\/g, "/").toLowerCase()));
  const kept = globMatcher(o.keep ?? []);
  try {
    for (const rule of rules.paths) {
      const r = ruleParts(rule), at = r ? places[r.place] : null;
      if (!r || !at || (r.segs.some(s => s.includes("<osUserName>")) && !user)) continue;
      const before = w.out.size;
      await walk(resolve(at), `<${r.place}>`, r.segs, 0, user, w, 0);
      if (w.out.size > before) where.add(rule);
    }
    const mayBeMade = (rel: string) => rules.made && !!o.installed && !shipped.has(rel.toLowerCase()) && !MADE_SKIP(rel);
    if (base && (o.keep?.length || (rules.made && o.installed))) {
      const all: Found[] = [];
      await baseFiles(resolve(base), "", rel => kept(rel) || mayBeMade(rel), all);
      const made: Found[] = [];
      for (const f of all) {
        const rel = f.p.slice("<base>/".length), key = f.p.toLowerCase();
        if (w.out.has(key)) continue;
        if (kept(rel)) { if (++w.count > L.files) throw tooMany(); w.out.set(key, f); where.add("<base>"); }
        else if (f.size <= L.madeFile) made.push(f);
      }
      // what the game made in its folder: saves while it is little, content (and left alone) when it is much
      if (made.length && made.length <= L.madeFiles && made.reduce((n, f) => n + f.size, 0) <= L.madeTotal) {
        for (const f of made) { if (++w.count > L.files) throw tooMany(); w.out.set(f.p.toLowerCase(), f); }
        where.add("<base>");
      }
    }
  } catch (e) { if (e instanceof SaveError && e.code === "too-big") return none; throw e; }
  // a file of the package is no save unless its keep globs say so (a rule may name a folder the game ships files in)
  const shippedFile = (f: Found) => f.p.startsWith("<base>/") && shipped.has(f.p.slice(7).toLowerCase()) && !kept(f.p.slice(7));
  const excluded = globMatcher(rules.exclude);
  const files = [...w.out.values()].filter(f => !shippedFile(f) && !excluded(f.p.slice(f.p.indexOf("/") + 1))).sort((a, b) => (a.p.toLowerCase() < b.p.toLowerCase() ? -1 : 1));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (files.some(f => f.size > L.file) || bytes > L.total) return none;
  return { files, bytes, newest: files.reduce<number | null>((m, f) => (m == null || f.mtime > m ? f.mtime : m), null), tooBig: false, where: [...where] };
}

/* ─────────── the digest ─────────── */

/** the digest of a set of saves: names (letter case aside), sizes and contents; null for no saves */
export function digestOf(list: readonly { p: string; s: number; h: string }[]): string | null {
  if (!list.length) return null;
  const h = createHash("sha256");
  for (const e of [...list].sort((a, b) => (a.p.toLowerCase() < b.p.toLowerCase() ? -1 : 1))) h.update(`${e.p.toLowerCase()}\0${e.s}\0${e.h}\n`);
  return h.digest("hex");
}
async function sha256(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}
/** sha256 by file name, kept with the size and time it was taken at: a file that has not changed is not read again */
export type Hashes = Record<string, [number, number, string]>;
export async function hashAll(files: readonly Found[], known: Hashes = {}): Promise<{ list: { p: string; s: number; h: string }[]; hashes: Hashes }> {
  const hashes: Hashes = {}, list: { p: string; s: number; h: string }[] = [];
  for (const f of files) {
    const key = f.p.toLowerCase(), k = known[key];
    const h = k && k[0] === f.size && k[1] === f.mtime ? k[2] : await sha256(f.abs).catch(() => null);
    if (h == null) continue;                                                // gone since it was found
    hashes[key] = [f.size, f.mtime, h];
    list.push({ p: f.p, s: f.size, h });
  }
  return { list, hashes };
}

/* ─────────── a version: packing and reading ─────────── */

/** pack these saves into one file; the answer is the list it ends with (a file that vanished meanwhile is not in it) */
export async function pack(files: readonly Found[], to: string): Promise<{ entries: Entry[]; digest: string | null; bytes: number; size: number }> {
  await mkdir(dirname(to), { recursive: true });
  const out = await open(to, "w");
  const entries: Entry[] = [];
  let at = 0;
  const put = async (b: Buffer) => { await out.write(b, 0, b.length, at); at += b.length; };
  try {
    await put(Buffer.from(MARK, "latin1"));
    for (const f of files) {
      const start = at, hash = createHash("sha256");
      let size = 0;
      try {
        const z = createDeflateRaw();
        const src = createReadStream(f.abs);
        src.on("data", c => { hash.update(c as Buffer); size += (c as Buffer).length; });
        src.on("error", e => z.destroy(e));
        src.pipe(z);
        for await (const chunk of z) await put(chunk as Buffer);
      } catch { at = start; continue; }                                      // it went away while it was read: not in this version
      entries.push({ p: f.p, s: size, m: f.mtime, h: hash.digest("hex"), z: at - start });
    }
    const list = Buffer.from(JSON.stringify({ v: 1, files: entries }), "utf8"), len = Buffer.alloc(4);
    len.writeUInt32LE(list.length);
    await out.truncate(at);
    await put(list); await put(len); await put(Buffer.from(MARK, "latin1"));
  } finally { await out.close(); }
  return { entries, digest: digestOf(entries), bytes: entries.reduce((n, e) => n + e.s, 0), size: at };
}

/** a version's list, read from its end; throws when the file is not a version */
export async function readList(fh: FileHandle, size: number): Promise<{ entries: Entry[]; bodies: number }> {
  const bad = () => new SaveError("that is not a set of saves", "bad");
  if (size < MARK.length * 2 + 4) throw bad();
  const tail = Buffer.alloc(MARK.length + 4), head = Buffer.alloc(MARK.length);
  await fh.read(tail, 0, tail.length, size - tail.length);
  await fh.read(head, 0, head.length, 0);
  if (tail.subarray(4).toString("latin1") !== MARK || head.toString("latin1") !== MARK) throw bad();
  const len = tail.readUInt32LE(0), bodies = size - tail.length - len;
  if (len > 64 * 1024 * 1024 || bodies < MARK.length) throw bad();
  const raw = Buffer.alloc(len);
  await fh.read(raw, 0, len, bodies);
  let j: { v?: unknown; files?: unknown };
  try { j = JSON.parse(raw.toString("utf8")); } catch { throw bad(); }
  if (j?.v !== 1 || !Array.isArray(j.files) || j.files.length > FILES_MAX) throw bad();
  const entries: Entry[] = [];
  let sum = MARK.length;
  for (const x of j.files as Partial<Entry>[]) {
    if (!x || typeof x.p !== "string" || !Number.isSafeInteger(x.s) || x.s! < 0 || x.s! > FILE_MAX || !Number.isSafeInteger(x.z) || x.z! < 0 || typeof x.h !== "string" || !/^[0-9a-f]{64}$/.test(x.h)) throw bad();
    entries.push({ p: x.p, s: x.s!, m: Number.isFinite(x.m) ? Number(x.m) : 0, h: x.h, z: x.z! });
    sum += x.z!;
  }
  if (sum !== bodies) throw bad();
  return { entries, bodies };
}

/** where a save of this name goes on this PC, or null when it has no place here (an unknown place, a path that would leave
 *  it, a name that can be no save) */
export function placeOf(p: string, places: Places): { place: Place; rel: string; abs: string } | null {
  const m = /^<([A-Za-z]+)>\/(.+)$/.exec(p);
  if (!m || !(PLACES as readonly string[]).includes(m[1]!) || !takeable(p)) return null;
  const at = places[m[1] as Place];
  if (m[2]!.includes("<osUserName>") && !places.osUserName) return null;
  const rel = m[2]!.replace(/<osUserName>/g, places.osUserName ?? "");
  if (!at || pathProblem(rel) !== null || rel.includes("\\")) return null;
  const abs = resolve(at, ...rel.split("/"));
  return within(resolve(at), abs) && abs !== resolve(at) ? { place: m[1] as Place, rel, abs } : null;
}
/** is a save of this name one the rules speak of: under one of their paths, a keep glob, or (made) anything the game made */
export function allowedBy(rules: Rules, o: ScanOpts): (p: string) => boolean {
  // a rule as a pattern over a save's path under its place: its names in order, ** any folders, and anything below its end
  const pattern = (segs: string[]) => {
    const s = [...segs];
    while (s.at(-1) === "**") s.pop();
    return new RegExp("^" + s.map(x => (x === "**" ? "(?:[^/]+/)*" : segSource(x) + "/")).join("").replace(/\/$/, "") + "(?:/.*)?$", "i");
  };
  const res = rules.paths.map(ruleParts).filter((r): r is NonNullable<typeof r> => !!r).map(r => ({ place: r.place, re: pattern(r.segs) }));
  const kept = globMatcher(o.keep ?? []), excluded = globMatcher(rules.exclude);
  const shipped = new Set((o.installed ?? []).map(f => f.replace(/\\/g, "/").toLowerCase()));
  return p => {
    const m = /^<([A-Za-z]+)>\/(.+)$/.exec(p);
    if (!m || excluded(m[2]!)) return false;
    if (m[1] === "base") {
      if (kept(m[2]!)) return true;
      if (shipped.has(m[2]!.toLowerCase())) return false;
      if (rules.made && !!o.installed && !MADE_SKIP(m[2]!)) return true;
    }
    return res.some(r => r.place === m[1] && r.re.test(m[2]!));
  };
}

/** is this folder really inside that place, links followed (a junction on the way must not lead a write out of it) */
async function reallyWithin(root: string, dir: string): Promise<boolean> {
  try { return within(await realpath(root), await realpath(dir)); } catch { return false; }
}
/** one save out of a pack into `to`: true when it came out as long as the list says and with its sha256 */
async function inflateTo(packFile: string, at: number, e: Entry, to: string): Promise<boolean> {
  if (e.z < 1) return false;
  const hash = createHash("sha256");
  let size = 0;
  try {
    await pipeline(createReadStream(packFile, { start: at, end: at + e.z - 1 }), createInflateRaw(), async function* (src: AsyncIterable<Buffer>) {
      for await (const c of src) { size += c.length; if (size > e.s) throw new Error("longer than it said"); hash.update(c); yield c; }
    }, createWriteStream(to));
  } catch { return false; }
  return size === e.s && hash.digest("hex") === e.h;
}
/** does a running program hold this file open (the game, writing its save)? Opening it for writing, which writes nothing, is refused then */
async function heldOpen(file: string): Promise<boolean> {
  try { await (await open(file, "r+")).close(); return false; } catch (e: any) { return e?.code === "EBUSY" || e?.code === "ETXTBSY"; }
}

export interface Restored { written: number; removed: number; skipped: number; backup: string | null; entries: Entry[] }
/**
 * Put a version back on this PC. Every save in it that has a place here and that the rules speak of is first written beside
 * where it goes and checked against the list; only when all of them are right is anything replaced. What is replaced or
 * removed is copied to `backupDir` first. `agreed`: the names this PC and the server agreed on last time; one of them that
 * this version no longer has, and that is still a save here by the rules, is removed.
 */
export async function restore(packFile: string, rules: Rules, places: Places, o: ScanOpts & { backupDir: string; agreed?: readonly string[] }): Promise<Restored> {
  const size = (await stat(packFile)).size;
  const fh = await open(packFile, "r");
  const temps: string[] = [];
  try {
    const { entries } = await readList(fh, size);
    const ok = allowedBy(rules, o);
    const plan: { e: Entry; abs: string; tmp: string; place: Place; rel: string }[] = [];
    let at = MARK.length, skipped = 0;
    for (const e of entries) {
      const where = ok(e.p) ? placeOf(e.p, places) : null;
      if (!where) { skipped++; at += e.z; continue; }
      const root = resolve(places[where.place]!), dir = dirname(where.abs);
      await mkdir(dir, { recursive: true });
      if (!(await reallyWithin(root, dir))) { skipped++; at += e.z; continue; }
      const cur = await lstat(where.abs).catch(() => null);
      if (cur && !cur.isFile()) { skipped++; at += e.z; continue; }           // a folder or a link where a file would go
      const tmp = where.abs + ".ahoy-new";
      temps.push(tmp);
      if (!(await inflateTo(packFile, at, e, tmp))) throw new SaveError("these saves did not arrive whole", "bad");
      plan.push({ e, abs: where.abs, tmp, place: where.place, rel: where.rel });
      at += e.z;
    }
    // what goes: agreed on last time, gone from this version, still a save here
    const have = new Set(entries.map(e => e.p.toLowerCase()));
    const gone: { abs: string; place: Place; rel: string }[] = [];
    if (o.agreed?.length) {
      const now = await scan(rules, places, o);
      const agreed = new Set(o.agreed.map(p => p.toLowerCase()));
      for (const f of now.files) {
        const key = f.p.toLowerCase(), w = agreed.has(key) && !have.has(key) ? placeOf(f.p, places) : null;
        if (w) gone.push({ abs: f.abs, place: w.place, rel: w.rel });
      }
    }
    // nothing changes while the game holds one of them open: half a set of saves is worse than the old one
    for (const x of [...plan, ...gone]) if (await heldOpen(x.abs)) throw new SaveError("the game holds its saves open — close it first", "busy");
    // a copy of everything that is about to change
    let backup: string | null = null;
    for (const x of [...plan, ...gone]) {
      if (!(await lstat(x.abs).catch(() => null))?.isFile()) continue;
      backup ??= o.backupDir;
      const to = join(o.backupDir, x.place, ...x.rel.split("/"));
      await mkdir(dirname(to), { recursive: true });
      await copyFile(x.abs, to);
    }
    for (const x of plan) {
      try { await rename(x.tmp, x.abs); }
      catch (e: any) { throw new SaveError(e?.code === "EBUSY" || e?.code === "EPERM" || e?.code === "EACCES" ? "the game holds its saves open — close it first" : String(e?.message ?? e), "busy"); }
      if (x.e.m > 0) await utimes(x.abs, new Date(), new Date(x.e.m)).catch(() => {});
    }
    let removed = 0;
    for (const x of gone) { await rm(x.abs, { force: true }).then(() => { removed++; }, () => {}); }
    return { written: plan.length, removed, skipped, backup, entries };
  } finally {
    await fh.close();
    for (const t of temps) await rm(t, { force: true }).catch(() => {});
  }
}

/** keep the newest BACKUPS backups of a game's saves */
export async function pruneBackups(dir: string): Promise<void> {
  const names = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => e.name).sort();
  for (const n of names.slice(0, Math.max(0, names.length - BACKUPS))) await rm(join(dir, n), { recursive: true, force: true }).catch(() => {});
}

/** a folder the person picked, as a rule: under the game's folder first, else the place that holds it most closely; null when
 *  it is in none of them, or is a whole place */
export function ruleFor(abs: string, places: Places): string | null {
  const order: Place[] = ["base", "winDocuments", "winAppData", "winLocalAppData", "winPublic", "winProgramData", "home"];
  const target = resolve(abs);
  // a folder that is one of the places, or holds one (Documents itself, the profile's AppData), is no folder of saves
  if (order.some(pl => !!places[pl] && within(target, resolve(places[pl]!)))) return null;
  for (const place of order) {
    const at = places[place];
    if (!at || !within(resolve(at), target) || resolve(at) === target) continue;
    const rel = target.slice(resolve(at).length).split(sep).filter(Boolean).join("/");
    const rule = `<${place}>/${rel}`;
    return ruleParts(rule) && !PRIVATE.test(rule) ? rule : null;
  }
  return null;
}

/* ─────────── what this PC remembers of a game's saves ─────────── */

/** the version this PC and the server agreed on last (the one it brought there or took from there), and the hashes it knows */
export interface Kept { base: { id: number; digest: string; files: string[] } | null; hashes: Hashes }
export const keyOk = (k: unknown): k is string => typeof k === "string" && /^[ag][0-9]{1,12}$/.test(k);
export async function readKept(file: string): Promise<Kept> {
  try {
    const j = JSON.parse(await readFile(file, "utf8")) as Partial<Kept>;
    const b = j?.base;
    const base = b && Number.isSafeInteger(b.id) && typeof b.digest === "string" && Array.isArray(b.files) ? { id: b.id, digest: b.digest, files: b.files.filter((x): x is string => typeof x === "string") } : null;
    return { base, hashes: j?.hashes && typeof j.hashes === "object" ? j.hashes as Hashes : {} };
  } catch { return { base: null, hashes: {} }; }
}
export const writeKept = (file: string, k: Kept) => mkdir(dirname(file), { recursive: true }).then(() => writeAtomic(file, JSON.stringify(k)));
