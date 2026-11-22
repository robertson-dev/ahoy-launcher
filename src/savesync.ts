/**
 * Ahoy launcher — a game's saves kept in step with the server (the work itself is saves.ts: finding, packing, putting back).
 *
 * One thing at a time per game. `state` looks: this PC's saves now (their digest), and the version this PC and the server
 * agreed on last. `push` brings this PC's saves to the server as its newest version. `pull` takes a version from there and
 * puts it back here (what it replaces is copied aside first). `agree` notes that this PC already has what a version has.
 * Which of these to do, and when, is the page's to decide (the server's web UI: saves.ts there); the launcher only does it,
 * with its own session, to its own server.
 *
 * What they agreed on last is kept in <dataDir>/saves/<key>.json; backups of what a pull replaced are in
 * <dataDir>/save-backups/<key>/<when>/. `key` names the game the same way on every PC: a<Steam app id>, else g<its id>.
 */
import { randomBytes } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SaveError, TOTAL_MAX, digestOf, hashAll, keyOk, pack, pruneBackups, readKept, restore, rulesOf, scan, writeKept, type Hashes, type Places, type ScanOpts } from "./saves";

/** a game on this PC, as far as its saves need it (engine.ts forSaves) */
export interface GameOnPc { slug: string; path: string; keep: string[]; installed: string[] | null }
/** this PC's saves of a game now, and the version it last agreed on with the server */
export interface SaveState { digest: string | null; files: number; bytes: number; newest: number | null; tooBig: boolean; where: string[]; base: { id: number; digest: string } | null }
export interface SavesOpts {
  dataDir: string;
  /** this PC's places, without the game's folder */
  places: () => Places;
  serverUrl: () => string;
  token: () => string;
  device: () => string;
  fetch?: typeof fetch;
  now?: () => number;
}
const TRANSFER_MS = 10 * 60_000;
/** how much of a version one request brings: under what a reverse proxy lets through at once by default (a megabyte), with
 *  room for the request's own lines */
export const PART = 512 * 1024;
const PART_MS = 60_000;

export class Saves {
  private turns = new Map<string, Promise<unknown>>();
  constructor(private o: SavesOpts) {}
  private keptFile(key: string) { return join(this.o.dataDir, "saves", `${key}.json`); }
  private places(g: GameOnPc): Places { return { ...this.o.places(), base: g.path }; }
  private opts(g: GameOnPc): ScanOpts { return { keep: g.keep, installed: g.installed }; }
  private one<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!keyOk(key)) return Promise.reject(new SaveError("no such game", "bad"));
    const run = (this.turns.get(key) ?? Promise.resolve()).then(fn, fn);
    const done = run.catch(() => {});
    this.turns.set(key, done);
    void done.then(() => { if (this.turns.get(key) === done) this.turns.delete(key); });
    return run;
  }
  private url(path: string) { return this.o.serverUrl().replace(/\/+$/, "") + path; }
  private headers(more: Record<string, string> = {}) { return { authorization: `Bearer ${this.o.token()}`, ...more }; }

  state(g: GameOnPc, key: string, rawRules: unknown): Promise<SaveState> {
    return this.one(key, async () => {
      const kept = await readKept(this.keptFile(key));
      const found = await scan(rulesOf(rawRules), this.places(g), this.opts(g));
      const { list, hashes } = await hashAll(found.files, kept.hashes);
      await writeKept(this.keptFile(key), { ...kept, hashes }).catch(() => {});
      return { digest: digestOf(list), files: list.length, bytes: list.reduce((n, e) => n + e.s, 0), newest: found.newest, tooBig: found.tooBig, where: found.where, base: kept.base ? { id: kept.base.id, digest: kept.base.digest } : null };
    });
  }

  /** this PC's saves become a version on the server (its newest); null when there are none here */
  push(g: GameOnPc, key: string, rawRules: unknown, about: { gameId?: number | null; name?: string | null } = {}): Promise<{ id: number; digest: string; same: boolean } | null> {
    return this.one(key, async () => {
      const found = await scan(rulesOf(rawRules), this.places(g), this.opts(g));
      if (found.tooBig) throw new SaveError("these saves are too large to keep in step", "too-big");
      if (!found.files.length) return null;
      const tmp = join(this.o.dataDir, "saves", `out-${key}.part`);
      try {
        const packed = await pack(found.files, tmp);
        if (!packed.digest) return null;
        const meta = { digest: packed.digest, files: packed.entries.length, bytes: packed.bytes, newest: packed.entries.reduce((m, e) => Math.max(m, e.m), 0) || null, device: this.o.device(), gameId: about.gameId ?? null, name: about.name ?? null };
        // in parts, one request each, in order; the last one's answer is the version (the first one's, when the server
        // already has these very saves as its newest)
        const size = (await stat(tmp)).size, count = Math.max(1, Math.ceil(size / PART)), upload = randomBytes(8).toString("hex");
        const said = encodeURIComponent(JSON.stringify(meta));
        const fh = await open(tmp, "r");
        let j: { item?: { id?: unknown; digest?: unknown }; same?: unknown; next?: unknown; error?: unknown } | null = null;
        try {
          for (let i = 0; i < count; i++) {
            const buf = Buffer.alloc(Math.min(PART, size - i * PART));
            await fh.read(buf, 0, buf.length, i * PART);
            let res: Response;
            try {
              res = await (this.o.fetch ?? fetch)(this.url(`/api/v1/saves/${key}`), {
                method: "POST", body: buf as unknown as BodyInit, signal: AbortSignal.timeout(PART_MS),
                headers: this.headers({ "content-type": "application/octet-stream", "content-length": String(buf.length), "x-ahoy-part": `${upload}:${i}:${count}`, "x-ahoy-save": said }),
              });
            } catch (e: any) { throw new SaveError(String(e?.message ?? e), "server"); }
            j = await res.json().catch(() => null);
            if (!res.ok) throw new SaveError(typeof j?.error === "string" ? j.error : `the server did not take the saves (HTTP ${res.status})`, res.status === 413 ? "too-big" : "server");
            if (j?.item) break;
            if (j?.next !== i + 1) throw new SaveError("the server lost its place in these saves", "server");
          }
        } finally { await fh.close(); }
        if (!Number.isSafeInteger(j?.item?.id) || j!.item!.digest !== packed.digest) throw new SaveError("the server did not take the saves", "server");
        const hashes: Hashes = {};
        for (const e of packed.entries) hashes[e.p.toLowerCase()] = [e.s, e.m, e.h];
        await writeKept(this.keptFile(key), { base: { id: j!.item!.id as number, digest: packed.digest, files: packed.entries.map(e => e.p) }, hashes });
        return { id: j!.item!.id as number, digest: packed.digest, same: j!.same === true };
      } finally { await rm(tmp, { force: true }).catch(() => {}); }
    });
  }

  /** a version from the server is put back on this PC (what it replaces is copied aside first) */
  pull(g: GameOnPc, key: string, rawRules: unknown, id: number): Promise<{ written: number; removed: number; skipped: number; digest: string | null }> {
    return this.one(key, async () => {
      if (!Number.isSafeInteger(id) || id <= 0) throw new SaveError("no such saves", "gone");
      const tmp = join(this.o.dataDir, "saves", `in-${key}.part`);
      await mkdir(dirname(tmp), { recursive: true });
      try {
        let res: Response;
        try { res = await (this.o.fetch ?? fetch)(this.url(`/api/v1/saves/${key}/${id}`), { headers: this.headers(), signal: AbortSignal.timeout(TRANSFER_MS) }); }
        catch (e: any) { throw new SaveError(String(e?.message ?? e), "server"); }
        if (res.status === 404) throw new SaveError("those saves are no longer on the server", "gone");
        if (!res.ok || !res.body) throw new SaveError(`the server did not send the saves (HTTP ${res.status})`, "server");
        const out = await open(tmp, "w");
        let got = 0;
        try {
          for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
            got += chunk.byteLength;
            if (got > TOTAL_MAX + 64 * 1024 * 1024) throw new SaveError("these saves are too large to keep in step", "too-big");
            await out.write(chunk);
          }
        } finally { await out.close(); }
        const kept = await readKept(this.keptFile(key));
        const stamp = new Date(this.o.now?.() ?? Date.now()).toISOString().replace(/[:.]/g, "-");
        const backups = join(this.o.dataDir, "save-backups", key);
        const r = await restore(tmp, rulesOf(rawRules), this.places(g), { ...this.opts(g), backupDir: join(backups, stamp), agreed: kept.base?.files });
        await pruneBackups(backups);
        const digest = digestOf(r.entries);
        if (digest) await writeKept(this.keptFile(key), { base: { id, digest, files: r.entries.map(e => e.p) }, hashes: {} });
        return { written: r.written, removed: r.removed, skipped: r.skipped, digest };
      } finally { await rm(tmp, { force: true }).catch(() => {}); }
    });
  }

  /** this PC has what that version has (their digests are the same): nothing moves, and that version is what they agree on */
  agree(g: GameOnPc, key: string, rawRules: unknown, snap: { id: number; digest: string }): Promise<boolean> {
    return this.one(key, async () => {
      const kept = await readKept(this.keptFile(key));
      const found = await scan(rulesOf(rawRules), this.places(g), this.opts(g));
      const { list, hashes } = await hashAll(found.files, kept.hashes);
      if (!snap || digestOf(list) !== snap.digest || !Number.isSafeInteger(snap.id)) return false;
      await writeKept(this.keptFile(key), { base: { id: snap.id, digest: snap.digest, files: list.map(e => e.p) }, hashes });
      return true;
    });
  }
}
