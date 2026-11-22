/**
 * Ahoy launcher — a game taken as blocks: a few requests instead of one per file.
 *
 * File by file (pull-http.ts) a game is one request for every file, one after another, nothing compressed, every changed
 * file whole on an update, and the whole game read a second time to check it. A server that has a package's block index
 * (the package says `blocks: { size, count, digest }`) sends it as blocks instead: each file cut at every MiB, each block
 * named by its sha256.
 *
 *   GET  <package>/blocks   the index: a 64-byte header ("AHOYBLK1", u32 block size, u32 files, u32 blocks, 12 bytes of
 *                           the server's own, the 32-byte digest of the file list), then every block's sha256: files in
 *                           the manifest's order, a file's blocks in order
 *   POST <package>/blocks   { digest, want: [[file, first block, count], …] } → those blocks in the order asked, as
 *                           frames: u8 kind (0 as it is, 1 one zstd frame, 255 an error, which ends the stream), u32
 *                           length (little-endian), payload
 *
 * What happens here:
 *   1. what is on disk already is not fetched. A file this launcher finished or stopped at (the state it keeps beside
 *      its other lists: each file's size and time, and which blocks it holds) is believed while it is still that size
 *      and time; any other file on disk is read and its blocks held against the new index. So an update brings only the
 *      blocks that changed, and a download that was stopped goes on where it was.
 *   2. the rest comes over a few streams at once, thousands of small files to a request. Every block is checked against
 *      its sha256 as it arrives and written in its place, so nothing is read again afterwards; one that does not check
 *      is never written, and asked for once more, alone.
 *   3. a stream that breaks is asked for again from the block it broke at.
 *
 * `unavailable` in the result: this package does not come as blocks from this server: an older server, an index that is
 * gone, a block that does not check twice, a file the server says it cannot send, an answer that is no block at all. The
 * caller then takes the package file by file, as before, where every file is held against the manifest: blocks are a
 * faster way to the same files, never the only way. What ends the install here is what file by file could not mend
 * either: signed out, the package replaced on the server meanwhile, a disk that cannot be written, a line that stays down.
 * Plain Node APIs only (Electron's main process, and bun test).
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { zstdDecompress } from "node:zlib";
import type { PullHandle, PullResult } from "./pull";

export const BLOCK = 1 << 20;
const MAGIC = "AHOYBLK1", HEADER = 64, HASH = 32;
const FRAME_RAW = 0, FRAME_ZSTD = 1, FRAME_ERROR = 255;
/** one request asks for about this much, and never for more runs than this (the server takes 256 MiB and 40,000) */
const REQUEST_BYTES = 32 * BLOCK, REQUEST_RUNS = 4000;
const STREAMS = 6, RETRIES = 5, OPEN_FILES = 24;

export interface BlockFile { path: string; size: number; sha256: string }
export interface BlocksInfo { size: number; count: number; digest: string }
export interface BlockPullResult extends PullResult { unavailable?: boolean }
export interface BlockPullHandle extends PullHandle { done: Promise<BlockPullResult> }
export interface BlockPullOpts {
  /** <server>/api/v1/package/<id>/blocks */
  url: string;
  headers: () => Record<string, string>;
  fetchImpl?: typeof fetch;
  /** the install folder */
  dest: string;
  /** the manifest's files in its order (what the index is over), and the ones to bring (a save already on disk is left out) */
  all: readonly BlockFile[];
  files: readonly BlockFile[];
  info: BlocksInfo;
  /** where this launcher keeps what it knows of the folder (<name>.json and <name>.blk); null: nothing is kept */
  state: string | null;
  streams?: number;
  requestBytes?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** while what is on disk is being read: bytes read so far, of how many */
  onScan?: (done: number, total: number) => void;
}

const blockCount = (size: number) => (size > 0 ? Math.ceil(size / BLOCK) : 0);
const blockLen = (size: number, i: number) => Math.min(BLOCK, size - i * BLOCK);
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest();

/** what ties an index to one list of files: the same digest the server makes */
export function filesDigest(files: readonly BlockFile[]): string {
  const h = createHash("sha256");
  for (const f of files) h.update(`${f.path}\0${f.size}\0${f.sha256}\n`);
  return h.digest("hex");
}
/** what a package says about its blocks, when it is something this launcher can take */
export function blocksInfoOf(x: unknown): BlocksInfo | null {
  const b = (x && typeof x === "object" ? x : {}) as { size?: unknown; count?: unknown; digest?: unknown };
  return b.size === BLOCK && Number.isSafeInteger(b.count) && (b.count as number) >= 0 && typeof b.digest === "string" && /^[0-9a-f]{64}$/.test(b.digest)
    ? { size: BLOCK, count: b.count as number, digest: b.digest } : null;
}

/** the hashes of an index, once it is known to be this file list's */
function hashesOf(index: Uint8Array, all: readonly BlockFile[], info: BlocksInfo): Buffer | null {
  const b = Buffer.from(index.buffer, index.byteOffset, index.byteLength);
  const blocks = all.reduce((n, f) => n + blockCount(f.size), 0);
  if (b.length !== HEADER + blocks * HASH || b.toString("latin1", 0, 8) !== MAGIC) return null;
  if (b.readUInt32LE(8) !== BLOCK || b.readUInt32LE(12) !== all.length || b.readUInt32LE(16) !== blocks || blocks !== info.count) return null;
  return b.toString("hex", 32, 64) === info.digest ? b.subarray(HEADER) : null;
}

/* ─────────── which blocks a file holds: one bit each ─────────── */

class Bits {
  readonly bytes: Uint8Array;
  constructor(readonly n: number, from?: Uint8Array) { this.bytes = new Uint8Array(Math.ceil(n / 8)); if (from && from.byteLength === this.bytes.byteLength) this.bytes.set(from); }
  has(i: number) { return (this.bytes[i >> 3]! & (1 << (i & 7))) !== 0; }
  set(i: number) { this.bytes[i >> 3]! |= 1 << (i & 7); }
  count() { let c = 0; for (let i = 0; i < this.n; i++) if (this.has(i)) c++; return c; }
}

/* ─────────── what this launcher knows of the folder ─────────── */

/** per file: its size and time when it was last left, and the blocks it held then (true: all of them) */
interface Kept { digest: string; list: [string, number][]; files: Record<string, [number, number, string | true]> }
interface Known { kept: Kept; hashes: Buffer; first: Map<string, { at: number; size: number }> }

async function loadState(base: string | null): Promise<Known | null> {
  if (!base) return null;
  try {
    const kept = JSON.parse(await readFile(`${base}.json`, "utf8")) as Kept;
    if (!kept || typeof kept.digest !== "string" || !Array.isArray(kept.list) || !kept.files || typeof kept.files !== "object") return null;
    const index = await readFile(`${base}.blk`);
    const all = kept.list.map(([path, size]) => ({ path: String(path), size: Number(size), sha256: "" }));
    const blocks = all.reduce((n, f) => n + blockCount(f.size), 0);
    if (index.length !== HEADER + blocks * HASH || index.toString("hex", 32, 64) !== kept.digest) return null;
    const first = new Map<string, { at: number; size: number }>();
    let at = 0;
    for (const f of all) { first.set(f.path, { at, size: f.size }); at += blockCount(f.size); }
    return { kept, hashes: index.subarray(HEADER), first };
  } catch { return null; }
}
async function writeAtomic(path: string, data: string | Uint8Array) {
  const tmp = `${path}.${process.pid}.tmp`;
  try { await writeFile(tmp, data); await rename(tmp, path); }
  catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
}
/** forget what is kept of a folder (it was uninstalled, or installed another way) */
export async function dropBlockState(base: string | null): Promise<void> {
  if (!base) return;
  await rm(`${base}.json`, { force: true }).catch(() => {});
  await rm(`${base}.blk`, { force: true }).catch(() => {});
}

/* ─────────── the pull ─────────── */

class Unavailable extends Error {}
class Fatal extends Error {}
type Run = [file: number, first: number, count: number];

export function startBlockPull(o: BlockPullOpts): BlockPullHandle {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const ac = new AbortController();
  const total = o.files.reduce((n, f) => n + f.size, 0);
  let here = 0;                                              // bytes of the files to bring that are in place

  const done: Promise<BlockPullResult> = run().then(
    () => ({ ok: true, localPath: o.dest, bytes: here }),
    (e: any) => ({ ok: false, localPath: o.dest, bytes: here, error: ac.signal.aborted && !(e instanceof Fatal) ? "cancelled" : String(e?.message ?? e), ...(e instanceof Unavailable ? { unavailable: true } : {}) }),
  );
  return { localPath: o.dest, done, progress: () => (total > 0 ? Math.min(1, here / total) : 1), bytes: () => here, cancel: () => ac.abort() };

  async function run(): Promise<void> {
    if (o.info.size !== BLOCK || filesDigest(o.all) !== o.info.digest) throw new Unavailable("the block index is not this file list's");
    const index = await getIndex();
    const hashes = hashesOf(index, o.all, o.info);
    if (!hashes) throw new Unavailable("the block index is not this file list's");
    // where each file's hashes start, and the files to bring by their place in the manifest
    const firstOf: number[] = [];
    let at = 0;
    for (const f of o.all) { firstOf.push(at); at += blockCount(f.size); }
    const place = new Map(o.all.map((f, i) => [f.path, i] as const));
    const bring: number[] = [];
    for (const f of o.files) {
      const i = place.get(f.path);
      if (i == null || o.all[i]!.size !== f.size) throw new Unavailable("a file to bring is not in the block index");
      bring.push(i);
    }
    bring.sort((a, b) => a - b);
    const hashOf = (fi: number, bi: number) => hashes.subarray((firstOf[fi]! + bi) * HASH, (firstOf[fi]! + bi + 1) * HASH);

    const have = new Map<number, Bits>();
    for (const fi of bring) have.set(fi, new Bits(blockCount(o.all[fi]!.size)));
    const writer = new Writer(o.dest, o.all);
    let finished = false;
    try {
      await whatIsHere(bring, have, hashOf);
      if (ac.signal.aborted) throw new Error("cancelled");
      await fetchMissing(bring, have, hashOf, writer);
      finished = true;
    } finally {
      await writer.closeAll();
      // what the folder holds now, for the next time: a stop is picked up from here, an update starts from here
      await saveState(bring, have, index, finished).catch(() => { /* nothing kept: the next time reads the files */ });
    }
  }

  async function getIndex(): Promise<Uint8Array> {
    let res: Response;
    try { res = await fetchImpl(o.url, { headers: o.headers(), signal: ac.signal }); }
    catch (e) { if (ac.signal.aborted) throw new Error("cancelled"); throw new Unavailable(`the block index did not come (${(e as Error)?.message ?? e})`); }
    if (res.status === 401) { await res.body?.cancel().catch(() => {}); throw new Fatal("you are signed out — sign in again"); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Unavailable(`the server answered ${res.status} for the block index`); }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** which blocks of the files to bring are in place already: by what this launcher kept of the folder, else by reading */
  async function whatIsHere(bring: number[], have: Map<number, Bits>, hashOf: (fi: number, bi: number) => Buffer) {
    const known = await loadState(o.state);
    const toRead: { fi: number; size: number }[] = [];
    for (const fi of bring) {
      const f = o.all[fi]!, bits = have.get(fi)!;
      const path = join(o.dest, f.path);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      if (!st.isFile()) throw new Fatal(`${f.path} is a folder on this PC where the game has a file`);
      const kept = known?.kept.files[f.path], old = known?.first.get(f.path);
      if (kept && old && st.size === kept[0] && st.mtimeMs === kept[1]) {
        // still the file this launcher left: its blocks are the ones it had then, where the new index names the same
        const held = kept[2] === true ? null : new Bits(blockCount(old.size), Buffer.from(kept[2], "base64"));
        for (let i = 0; i < Math.min(bits.n, blockCount(old.size)); i++) {
          if (held && !held.has(i)) continue;
          if (i * BLOCK + blockLen(old.size, i) > st.size) continue;                 // never written that far
          if (blockLen(old.size, i) === blockLen(f.size, i) && known!.hashes.subarray((old.at + i) * HASH, (old.at + i + 1) * HASH).equals(hashOf(fi, i))) { bits.set(i); here += blockLen(f.size, i); }
        }
      } else if (st.size > 0 && f.size > 0) toRead.push({ fi, size: Math.min(st.size, f.size) });
      // a file of another size takes the new one now: what it shares with the new file is at its start, and stays
      if (st.size !== f.size) await truncate(path, f.size);
    }
    const readTotal = toRead.reduce((n, r) => n + r.size, 0);
    let read = 0, told = 0;
    for (const { fi, size } of toRead) {
      const f = o.all[fi]!, bits = have.get(fi)!;
      const fh = await open(join(o.dest, f.path), "r");
      try {
        const buf = Buffer.allocUnsafe(BLOCK);
        for (let i = 0; i * BLOCK < size; i++) {
          if (ac.signal.aborted) throw new Error("cancelled");
          const len = blockLen(f.size, i);
          let got = 0;
          while (got < len) { const { bytesRead } = await fh.read(buf, got, len - got, i * BLOCK + got); if (!bytesRead) break; got += bytesRead; }
          if (got === len && sha256(buf.subarray(0, len)).equals(hashOf(fi, i))) { bits.set(i); here += len; }
          read += Math.min(len, size - i * BLOCK);
          if (Date.now() - told > 300) { told = Date.now(); o.onScan?.(read, readTotal); }
        }
      } finally { await fh.close(); }
    }
    if (readTotal) o.onScan?.(readTotal, readTotal);
  }

  async function fetchMissing(bring: number[], have: Map<number, Bits>, hashOf: (fi: number, bi: number) => Buffer, writer: Writer) {
    // the runs still to come, in the manifest's order; an empty file is simply made
    const queue: Run[] = [];
    for (const fi of bring) {
      const f = o.all[fi]!, bits = have.get(fi)!;
      if (f.size === 0) { await writer.empty(fi); continue; }
      for (let i = 0; i < bits.n;) {
        if (bits.has(i)) { i++; continue; }
        let j = i; while (j < bits.n && !bits.has(j)) j++;
        queue.push([fi, i, j - i]); i = j;
      }
    }
    if (!queue.length) return;
    const perRequest = Math.max(BLOCK, o.requestBytes ?? REQUEST_BYTES);
    /** the next request's worth of runs, taken off the front of the queue (a long run is cut) */
    const take = (): Run[] | null => {
      if (!queue.length) return null;
      const batch: Run[] = [];
      let bytes = 0;
      while (queue.length && batch.length < REQUEST_RUNS && bytes < perRequest) {
        const [fi, first, count] = queue[0]!;
        const size = o.all[fi]!.size;
        let n = 0, add = 0;
        while (n < count && (bytes + add < perRequest || (n === 0 && !batch.length))) { add += blockLen(size, first + n); n++; }
        if (!n) break;
        batch.push([fi, first, n]); bytes += add;
        if (n === count) queue.shift(); else queue[0] = [fi, first + n, count - n];
      }
      return batch;
    };
    const again = new Map<string, number>();                 // blocks that did not check once: asked for once more
    let inflight = 0, fatal: Error | null = null;
    const waiting: (() => void)[] = [];
    const wake = () => { for (const w of waiting.splice(0)) w(); };
    const stopAll = (e: Error) => { fatal ??= e; ac.abort(); wake(); };

    const worker = async () => {
      let fails = 0;
      for (;;) {
        if (fatal || ac.signal.aborted) return;
        const batch = take();
        if (!batch) {
          if (!inflight) return;
          await new Promise<void>(r => waiting.push(r));     // another stream may hand blocks back
          continue;
        }
        inflight++;
        let got = 0;
        const left = batch.map(r => [...r] as Run);          // what of this request is still to come
        try {
          await request(batch, async (fi, bi, raw) => {
            const f = o.all[fi]!;
            if (!sha256(raw).equals(hashOf(fi, bi))) {
              const key = `${fi}:${bi}`, n = (again.get(key) ?? 0) + 1;
              again.set(key, n);
              if (n > 1) throw new Unavailable(`a block of ${f.path} is not the one the index names`);
              queue.push([fi, bi, 1]);
            } else {
              // a disk that is full or a file that cannot be written does not get better by asking the server again
              try { await writer.write(fi, bi * BLOCK, raw); }
              catch (e: any) { throw new Fatal(`${f.path} could not be written on this PC (${e?.code ?? e?.message ?? e})`); }
              have.get(fi)!.set(bi); here += raw.byteLength;
            }
            got++;
            if (left[0]![2] === 1) left.shift(); else left[0] = [left[0]![0], left[0]![1] + 1, left[0]![2] - 1];
          });
          fails = 0;
        } catch (e: any) {
          queue.unshift(...left);                             // from the block it broke at
          if (e instanceof Fatal || e instanceof Unavailable) { stopAll(e); return; }
          if (ac.signal.aborted) return;
          if (got) fails = 0;
          if (++fails > (o.retries ?? RETRIES)) { stopAll(new Fatal(String(e?.message ?? e))); return; }
          await sleep(Math.min(30_000, 1000 * 2 ** (fails - 1)));
        } finally { inflight--; wake(); }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, o.streams ?? STREAMS) }, worker));
    if (fatal) throw fatal;
    if (ac.signal.aborted) throw new Error("cancelled");
    for (const fi of bring) if (have.get(fi)!.count() !== have.get(fi)!.n) throw new Fatal("part of the game did not arrive — try again");
  }

  /** one request: the blocks of `runs`, each handed to `got` in order once it is whole (unpacked, not yet checked) */
  async function request(runs: Run[], got: (fi: number, bi: number, raw: Buffer) => Promise<void>): Promise<void> {
    const res = await fetchImpl(o.url, { method: "POST", headers: { ...o.headers(), "content-type": "application/json" }, body: JSON.stringify({ digest: o.info.digest, want: runs }), signal: ac.signal });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 401) throw new Fatal("you are signed out — sign in again");
      if (res.status === 409) throw new Fatal("the game changed on the server while it was downloading — start it again");
      if ([400, 404, 405, 413, 501].includes(res.status)) throw new Unavailable(`the server answered ${res.status} for blocks`);
      throw new Error(`the server answered ${res.status}`);
    }
    if (!res.body) throw new Error("the server sent nothing");
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let buffered = 0;
    /** exactly n bytes of the stream, or null when it ended first */
    const bytes = async (n: number): Promise<Buffer | null> => {
      while (buffered < n) {
        const { value, done } = await reader.read();
        if (done) return null;
        if (value?.byteLength) { parts.push(value); buffered += value.byteLength; }
      }
      const out = Buffer.allocUnsafe(n);
      for (let filled = 0; filled < n;) {
        const p = parts[0]!, need = n - filled;
        if (p.byteLength <= need) { out.set(p, filled); filled += p.byteLength; parts.shift(); }
        else { out.set(p.subarray(0, need), filled); parts[0] = p.subarray(need); filled = n; }
      }
      buffered -= n;
      return out;
    };
    try {
      for (const [fi, first, count] of runs) {
        const size = o.all[fi]!.size;
        for (let bi = first; bi < first + count; bi++) {
          const head = await bytes(5);
          if (!head) throw new Error("the connection ended early");
          const kind = head[0]!, len = head.readUInt32LE(1), want = blockLen(size, bi);
          // the server could not send a file as the one it indexed (its own words stay in its log)
          if (kind === FRAME_ERROR) throw new Unavailable("the server could not send a block");
          if ((kind !== FRAME_RAW && kind !== FRAME_ZSTD) || len > want || (kind === FRAME_RAW && len !== want) || len === 0) throw new Unavailable("the server sent something that is not a block");
          const payload = await bytes(len);
          if (!payload) throw new Error("the connection ended early");
          const raw = kind === FRAME_ZSTD ? await unzstd(payload, want) : payload;
          if (raw.byteLength !== want) throw new Unavailable("the server sent something that is not a block");
          await got(fi, bi, raw);
        }
      }
    } finally { await reader.cancel().catch(() => {}); }
  }

  async function saveState(bring: number[], have: Map<number, Bits>, index: Uint8Array, finished: boolean) {
    if (!o.state) return;
    const files: Kept["files"] = {};
    for (const fi of bring) {
      const f = o.all[fi]!, bits = have.get(fi)!;
      const st = await stat(join(o.dest, f.path)).catch(() => null);
      if (!st?.isFile()) continue;
      const whole = bits.count() === bits.n;
      if (!whole && !bits.count()) continue;
      files[f.path] = [st.size, st.mtimeMs, whole ? true : Buffer.from(bits.bytes).toString("base64")];
    }
    if (!finished && !Object.keys(files).length) return;
    await mkdir(dirname(o.state), { recursive: true });
    const kept: Kept = { digest: o.info.digest, list: o.all.map(f => [f.path, f.size]), files };
    // the hashes first: a state that names hashes which are not beside it is not believed (loadState)
    await writeAtomic(`${o.state}.blk`, index);
    await writeAtomic(`${o.state}.json`, JSON.stringify(kept));
  }
}

const unzstd = (payload: Buffer, want: number) => new Promise<Buffer>((done, fail) => {
  zstdDecompress(payload, { maxOutputLength: want }, (e, out) => (e ? fail(new Unavailable("the server sent something that is not a block")) : done(out)));
});

/** the files of the install folder, written at any place in any order by several streams: a few kept open at a time */
class Writer {
  private handles = new Map<number, { fh: Promise<FileHandle>; users: number; used: number }>();
  private dirs = new Set<string>();
  private tick = 0;
  constructor(private dest: string, private all: readonly BlockFile[]) {}

  private async dir(path: string) {
    const d = dirname(path);
    if (!this.dirs.has(d)) { await mkdir(d, { recursive: true }); this.dirs.add(d); }
  }
  private acquire(fi: number) {
    let h = this.handles.get(fi);
    if (!h) {
      const path = join(this.dest, this.all[fi]!.path);
      const fh = this.dir(path).then(() => open(path, "r+").catch((e: any) => { if (e?.code === "ENOENT") return open(path, "w+"); throw e; }));
      h = { fh, users: 0, used: 0 };
      this.handles.set(fi, h);
    }
    h.users++; h.used = ++this.tick;
    return h;
  }
  private async trim() {
    if (this.handles.size <= OPEN_FILES) return;
    const idle = [...this.handles].filter(([, h]) => !h.users).sort((a, b) => a[1].used - b[1].used);
    for (const [fi, h] of idle.slice(0, this.handles.size - OPEN_FILES)) { this.handles.delete(fi); await h.fh.then(f => f.close(), () => {}); }
  }
  async write(fi: number, pos: number, data: Uint8Array) {
    const h = this.acquire(fi);
    try {
      const fh = await h.fh;
      for (let off = 0; off < data.byteLength;) { const { bytesWritten } = await fh.write(data, off, data.byteLength - off, pos + off); off += bytesWritten; }
    } catch (e) { h.users--; this.handles.delete(fi); await h.fh.then(f => f.close(), () => {}); throw e; }
    h.users--;
    await this.trim();
  }
  /** a file of no bytes: made, and cut to nothing when something was there */
  async empty(fi: number) {
    const path = join(this.dest, this.all[fi]!.path);
    await this.dir(path);
    await writeFile(path, new Uint8Array());
  }
  async closeAll() {
    const all = [...this.handles.values()];
    this.handles.clear();
    for (const h of all) await h.fh.then(f => f.close(), () => {});
  }
}
