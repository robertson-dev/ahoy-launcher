/**
 * ludarr — native HTTP(S) pull engine: segmented, resumable, no external binary.
 *
 * Used in bosun mode. The source says where bytes come from — the seedbox's own https file listing
 * (fast) or the connector's /v1/fs/file through the SSH tunnel — both speak Range. Each file is split
 * into N segments fetched concurrently and written in place at their offsets; progress is checkpointed
 * to a `<file>.ahoy-part` sidecar so a restart picks up where it left off. Directories are mirrored
 * file by file; files already complete on disk are skipped.
 */
import { mkdir, open, stat, readFile, writeFile, unlink } from "node:fs/promises";
import { join, posix, dirname } from "node:path";
import type { PullJob, PullHandle, PullResult } from "./pull";

export interface RemoteEntry { name: string; size: number; isDir: boolean }
export interface HttpSource {
  stat(path: string): Promise<{ size: number; isDir: boolean }>;
  list(path: string): Promise<RemoteEntry[]>;
  request(path: string): Promise<{ url: string; headers?: Record<string, string> }>;
}
export interface HttpPullOpts {
  downloadsDir: string;
  segments?: number;            // per file (default 4)
  minSegmentBytes?: number;     // never split below this (default 8 MiB)
  retries?: number;             // per segment (default 5)
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface Seg { start: number; end: number; done: number }        // [start, end); done = bytes written from start
interface PartState { size: number; segs: Seg[] }
interface PlannedFile { remote: string; local: string; size: number }

export const PART_EXT = ".ahoy-part";

export function startHttpPull(job: PullJob, src: HttpSource, opts: HttpPullOpts): PullHandle {
  const name = posix.basename(job.remotePath.replace(/\\/g, "/").replace(/\/+$/, "")) || "download";
  const localPath = join(opts.downloadsDir, name);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));   // runtime-agnostic: the launcher runs this under Node
  const ac = new AbortController();
  let settled = 0;     // bytes of files fully on disk
  let inflight = 0;    // bytes so far of the file in progress
  const total = () => settled + inflight;

  const done: Promise<PullResult> = run().catch((e: any) => ({
    ok: false, localPath, bytes: total(), error: ac.signal.aborted ? "cancelled" : String(e?.message ?? e),
  }));

  return {
    localPath, done,
    progress: () => (job.expectedBytes > 0 ? Math.min(1, total() / job.expectedBytes) : 0),
    bytes: total,
    cancel: () => ac.abort(),
  };

  async function run(): Promise<PullResult> {
    const files = await plan();
    for (const f of files) {
      if (ac.signal.aborted) throw new Error("cancelled");
      await mkdir(dirname(f.local), { recursive: true });
      const have = await stat(f.local).catch(() => null);
      const part = await readPart(f.local);
      if (have?.isFile() && have.size === f.size && !part) { settled += f.size; continue; }
      await downloadFile(f, part, !!have?.isFile());
      settled += f.size;
      inflight = 0;
    }
    return { ok: true, localPath, bytes: total() };
  }

  async function plan(): Promise<PlannedFile[]> {
    if (!job.isDir) {
      const s = await src.stat(job.remotePath);
      if (!s.isDir) return [{ remote: job.remotePath, local: localPath, size: s.size }];
    }
    return walk(job.remotePath, localPath);
  }

  async function walk(rp: string, lp: string): Promise<PlannedFile[]> {
    const out: PlannedFile[] = [];
    await mkdir(lp, { recursive: true });
    for (const e of await src.list(rp)) {
      const r = posix.join(rp, e.name), l = join(lp, e.name);
      if (e.isDir) out.push(...await walk(r, l));
      else out.push({ remote: r, local: l, size: e.size });
    }
    return out;
  }

  async function readPart(local: string): Promise<PartState | null> {
    try {
      const p = JSON.parse(await readFile(local + PART_EXT, "utf8")) as PartState;
      return Array.isArray(p.segs) && typeof p.size === "number" ? p : null;
    } catch { return null; }
  }

  /** a sidecar is believed only while its file is there and its segments are whole: in order, covering the file, none past its end */
  function usable(part: PartState | null, f: PlannedFile, fileThere: boolean): part is PartState {
    if (!part || !fileThere || part.size !== f.size || !part.segs.length) return false;
    let at = 0;
    for (const s of part.segs) {
      if (!s || !Number.isInteger(s.start) || !Number.isInteger(s.end) || !Number.isInteger(s.done)) return false;
      if (s.start !== at || s.end <= s.start || s.done < 0 || s.done > s.end - s.start) return false;
      at = s.end;
    }
    return at === f.size && part.segs.some(s => s.done > 0);
  }

  async function downloadFile(f: PlannedFile, part: PartState | null, fileThere: boolean) {
    const partFile = f.local + PART_EXT;
    if (f.size === 0) { await writeFile(f.local, new Uint8Array()); await unlink(partFile).catch(() => {}); return; }
    let state: PartState;
    // anything else (the file gone while its sidecar stayed, a sidecar that does not add up) starts the file again
    if (usable(part, f, fileThere)) state = part;
    else {
      const n = Math.max(1, Math.min(opts.segments ?? 4, Math.floor(f.size / (opts.minSegmentBytes ?? 8 * 1024 * 1024)) || 1));
      const per = Math.ceil(f.size / n);
      state = { size: f.size, segs: Array.from({ length: n }, (_, i) => ({ start: i * per, end: Math.min(f.size, (i + 1) * per), done: 0 })).filter(s => s.end > s.start) };
      await (await open(f.local, "w")).close();          // create / truncate
    }
    const save = () => writeFile(partFile, JSON.stringify(state));
    const sum = () => state.segs.reduce((a, s) => a + s.done, 0);
    inflight = sum();
    await save();
    let lastSave = Date.now();
    const onProgress = async () => {
      inflight = sum();
      if (Date.now() - lastSave > 2000) { lastSave = Date.now(); await save(); }
    };
    // one segment that gives up stops the others, and the file is left only once every one of them has let go of it:
    // nothing writes to it (or to its sidecar) after the pull has reported
    const stop = new AbortController();
    const onCancel = () => stop.abort();
    ac.signal.addEventListener("abort", onCancel);
    if (ac.signal.aborted) stop.abort();
    let failed: { e: unknown } | null = null;
    try {
      await Promise.allSettled(state.segs.map(seg => runSegment(f, seg, state.segs.length, onProgress, stop.signal).catch(e => { failed ??= { e }; stop.abort(); })));
    } finally {
      ac.signal.removeEventListener("abort", onCancel);
      await save();                                       // the sidecar always reflects what is on disk
    }
    if (ac.signal.aborted) throw new Error("cancelled");
    if (failed) throw (failed as { e: unknown }).e;
    if (sum() !== f.size) throw new Error(`short download: ${sum()}/${f.size} bytes of ${f.remote}`);
    await unlink(partFile).catch(() => {});
  }

  async function runSegment(f: PlannedFile, seg: Seg, nSegs: number, onProgress: () => Promise<void>, signal: AbortSignal) {
    const retries = opts.retries ?? 5;
    for (let attempt = 0; seg.done < seg.end - seg.start; attempt++) {
      if (signal.aborted) return;
      const before = seg.done;
      try {
        const from = seg.start + seg.done, to = seg.end - 1;
        const { url, headers } = await src.request(f.remote);
        const res = await fetchImpl(url, { headers: { ...headers, range: `bytes=${from}-${to}` }, signal });
        if (res.status === 200) {
          if (from !== 0 || nSegs > 1) {
            await res.body?.cancel().catch(() => {});
            throw new Error("server ignored Range (set PULL_SEGMENTS=1 if it never supports it)");
          }
        } else if (res.status !== 206) {
          await res.body?.cancel().catch(() => {});
          throw new Error(`HTTP ${res.status} for ${f.remote}`);
        }
        if (!res.body) throw new Error("empty body");
        const fh = await open(f.local, "r+");
        try {
          const reader = res.body.getReader();
          let pos = from;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value?.length) continue;
            const room = seg.end - pos;
            const chunk = value.length > room ? value.subarray(0, room) : value;
            await fh.write(chunk, 0, chunk.length, pos);
            pos += chunk.length;
            seg.done = pos - seg.start;
            await onProgress();
            if (pos >= seg.end || signal.aborted) { await reader.cancel().catch(() => {}); break; }
          }
        } finally { await fh.close(); }
        if (seg.done < seg.end - seg.start) throw new Error(`connection ended early at byte ${seg.start + seg.done} of ${f.remote}`);
      } catch (e) {
        if (signal.aborted) return;
        if (seg.done > before) attempt = 0;               // a try that got somewhere is not one of the tries in a row that give up
        if (attempt >= retries) throw e;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
      }
    }
  }
}
