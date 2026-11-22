/**
 * ludarr — remote client → this machine, driven by lftp.
 *
 * One transport URL covers sftp:// ftps:// ftp:// — whatever the seedbox host offers —
 * and lftp gives us segmented (pget -n) + resumable (-c / --continue) pulls for free.
 * The script goes in over stdin so credentials never appear on a command line.
 * Progress is measured on disk (allocated blocks, so sparse pget targets don't lie),
 * not scraped from lftp's output.
 */
import { stat, readdir, mkdir } from "node:fs/promises";
import { join, posix } from "node:path";
export interface PullJob { remotePath: string; isDir: boolean; expectedBytes: number }
/** how to reach the remote files: sftp:// ftps:// ftp:// (or https://) with credentials in the URL */
export interface PullOpts { url: string; downloadsDir: string; pathStrip?: string; verifyTls?: boolean; segments?: number }
export interface PullResult { ok: boolean; localPath: string; bytes: number; error?: string }
export interface PullHandle {
  localPath: string;
  done: Promise<PullResult>;
  progress(): number;
  bytes(): number;
  cancel(): void;
}

/** the slice of Bun.spawn we use — swappable in tests */
export interface SpawnLike {
  stdin: { write(s: string): unknown; end(): unknown };
  stderr: ReadableStream<Uint8Array> | null | number;
  exited: Promise<number>;
  kill(): void;
}
export type Spawner = (cmd: string[]) => SpawnLike;

/** what a folder (or file) weighs right now: bytes and entries, walked through whatever filesystem it is on */
export async function measure(p: string): Promise<{ bytes: number; files: number }> {
  const s = await stat(p).catch(() => null);
  if (!s) return { bytes: 0, files: 0 };
  if (!s.isDirectory()) return { bytes: s.size, files: 1 };
  let bytes = 0, files = 0;
  for (const e of await readdir(p, { withFileTypes: true }).catch(() => [])) {
    const m = await measure(join(p, e.name));
    bytes += m.bytes; files += m.files;
  }
  return { bytes, files };
}

/**
 * a finished download that should be visible under a mounted client folder (remote path mapping). The client says
 * it is complete, but the folder is read through a mount (whose listing may lag) or a sync (which may still be
 * copying): wait for it to appear, then for two measurements `settleMs` apart to agree before handing it to the
 * import — never a half-arrived folder.
 */
export function waitForLocal(localPath: string, job: PullJob, opts: { pollMs?: number; maxMs?: number; settleMs?: number; exists?: (p: string) => Promise<boolean>; measure?: (p: string) => Promise<{ bytes: number; files: number }> } = {}): PullHandle {
  const pollMs = opts.pollMs ?? 15_000, maxMs = opts.maxMs ?? 6 * 3600_000, settleMs = opts.settleMs ?? 20_000;
  const exists = opts.exists ?? (async (p: string) => !!(await stat(p).catch(() => null)));
  const weigh = opts.measure ?? measure;
  let cancelled = false, timer: ReturnType<typeof setTimeout> | null = null, wake: (() => void) | null = null, seen = 0;
  const sleep = (ms: number) => new Promise<void>(r => { wake = r; timer = setTimeout(r, ms); });
  const done = (async (): Promise<PullResult> => {
    const t0 = Date.now();
    while (!cancelled && !(await exists(localPath))) {
      if (Date.now() - t0 >= maxMs) return { ok: false, localPath, bytes: 0, error: `${localPath} never appeared under the mapped folder — is the mount up?` };
      await sleep(pollMs);
    }
    let last = await weigh(localPath); seen = last.bytes;
    while (!cancelled) {
      await sleep(settleMs);
      if (cancelled) break;
      const now = await weigh(localPath); seen = now.bytes;
      if (now.bytes === last.bytes && now.files === last.files && now.files > 0) return { ok: true, localPath, bytes: now.bytes };
      if (Date.now() - t0 >= maxMs) return { ok: false, localPath, bytes: now.bytes, error: `${localPath} kept changing for hours — is something still writing it?` };
      last = now;
    }
    return { ok: false, localPath, bytes: seen, error: "cancelled" };
  })();
  return { localPath, done, progress: () => (job.expectedBytes > 0 ? Math.min(100, Math.round((seen / job.expectedBytes) * 100)) : 0), bytes: () => seen, cancel() { cancelled = true; if (timer) clearTimeout(timer); wake?.(); } };
}

export function transportUrl(raw: string): URL | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return /^(sftp|ftps?|https?):$/.test(u.protocol) ? u : null;
  } catch { return null; }
}
export const lftpAvailable = () => !!Bun.which("lftp");

/** seedbox absolute path → path as the transport sees it (chrooted FTP needs the home prefix dropped) */
export function remotePath(seedboxPath: string, pathStrip = ""): string {
  const strip = pathStrip.replace(/\/+$/, "");
  let p = seedboxPath.replace(/\\/g, "/");
  if (strip && p === strip) p = "/";
  else if (strip && p.startsWith(strip + "/")) p = p.slice(strip.length);
  return p || "/";
}

/** lftp double-quoted argument: backslashes and quotes escaped */
const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export function localPathFor(job: PullJob, opts: Pick<PullOpts, "downloadsDir" | "pathStrip">): string {
  return join(opts.downloadsDir, posix.basename(remotePath(job.remotePath, opts.pathStrip)));
}

export function lftpScript(u: URL, job: PullJob, opts: PullOpts): string {
  const seg = opts.segments || 8;
  const verify = opts.verifyTls !== false;
  const auth = u.username ? `${u.username}${u.password ? ":" + u.password : ""}@` : "";
  const host = `${u.protocol}//${auth}${u.hostname}${u.port ? ":" + u.port : ""}`;
  const remote = remotePath(job.remotePath, opts.pathStrip);
  const local = localPathFor(job, opts);
  const localDir = posix.dirname(local.replace(/\\/g, "/"));
  return [
    "set cmd:interactive no",
    "set cmd:fail-exit yes",
    "set sftp:auto-confirm yes",
    `set ssl:verify-certificate ${verify ? "yes" : "no"}`,
    "set net:timeout 30",
    "set net:max-retries 5",
    "set net:reconnect-interval-base 5",
    "set net:reconnect-interval-max 60",
    "set xfer:clobber on",
    `set pget:default-n ${seg}`,
    `open ${q(host)}`,
    job.isDir
      ? `mirror --continue --use-pget-n=${seg} --parallel=2 --no-perms ${q(remote)} ${q(local)}`
      : `pget -c -n ${seg} -O ${q(localDir)} ${q(remote)}`,
    "quit",
  ].join("\n") + "\n";
}

/** bytes actually on disk (allocated blocks when the fs reports them, else logical size) */
export async function diskBytes(path: string): Promise<number> {
  const st = await stat(path);
  const real = (s: typeof st) => (s.blocks && s.blocks > 0 ? Math.min(s.size, s.blocks * 512) : s.size);
  if (!st.isDirectory()) return real(st);
  let total = 0;
  for (const ent of await readdir(path, { withFileTypes: true })) {
    const p = join(path, ent.name);
    if (ent.isDirectory()) total += await diskBytes(p);
    else if (ent.isFile()) total += real(await stat(p));
  }
  return total;
}

const realSpawn: Spawner = cmd => Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "pipe" }) as unknown as SpawnLike;

export function startPull(job: PullJob, opts: PullOpts, spawn: Spawner = realSpawn): PullHandle {
  const localPath = localPathFor(job, opts);
  let bytes = 0, cancelled = false, proc: SpawnLike | null = null;

  const done = (async (): Promise<PullResult> => {
    const u = transportUrl(opts.url);
    if (!u) return { ok: false, localPath, bytes: 0, error: "no transfer URL (sftp://host) on this download client" };
    const bin = Bun.which("lftp");
    if (!bin && spawn === realSpawn) return { ok: false, localPath, bytes: 0, error: "lftp not installed on this host" };
    await mkdir(opts.downloadsDir, { recursive: true });
    proc = spawn([bin ?? "lftp"]);
    proc.stdin.write(lftpScript(u, job, opts));
    proc.stdin.end();
    const stderrP = proc.stderr && typeof proc.stderr !== "number" ? new Response(proc.stderr).text() : Promise.resolve("");
    const poll = setInterval(() => { diskBytes(localPath).then(b => { bytes = b; }).catch(() => {}); }, 2000);
    const code = await proc.exited;
    clearInterval(poll);
    bytes = await diskBytes(localPath).catch(() => bytes);
    const err = (await stderrP).trim().split("\n").filter(Boolean).slice(-4).join(" | ");
    if (cancelled) return { ok: false, localPath, bytes, error: "cancelled" };
    if (code !== 0) return { ok: false, localPath, bytes, error: `lftp exit ${code}${err ? ": " + err : ""}` };
    return { ok: true, localPath, bytes };
  })();

  return {
    localPath,
    done,
    progress: () => (job.expectedBytes > 0 ? Math.min(1, bytes / job.expectedBytes) : 0),
    bytes: () => bytes,
    cancel: () => { cancelled = true; proc?.kill(); },
  };
}
