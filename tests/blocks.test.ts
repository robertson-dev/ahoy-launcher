/**
 * A game taken as blocks (src/pull/blocks.ts, through the engine):
 *  - a few requests for a whole game, however many files it has; none for a file by itself; nothing read again afterwards
 *  - what is on disk already is not fetched: an update brings only the blocks that changed, a download that was stopped
 *    goes on where it was, with or without what the launcher kept of it
 *  - every block is checked as it arrives: one that does not check is asked for once more, and never written
 *  - a stream that breaks is asked for again from the block it broke at
 *  - blocks are a faster way to the same files, never the only way: a server that cannot send them (an older one, an
 *    index that is gone), or whose blocks cannot be trusted (one that never checks, a file it says it cannot send, an
 *    answer that is no block), is asked file by file, as before, where every file is held against the manifest
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { Engine, type EngineEvent, type Manifest } from "../src/engine";
import { BLOCK, blocksInfoOf, filesDigest } from "../src/pull/blocks";

const KEY = "deadbeefcafe";
type Bytes = Uint8Array<ArrayBuffer>;
const noise = (n: number): Bytes => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const text = (n: number, word = "the quick brown fox jumps over the lazy dog. "): Bytes => new Uint8Array(Buffer.alloc(n, word));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const nBlocks = (size: number) => (size > 0 ? Math.ceil(size / BLOCK) : 0);

/* a fake Ahoy server that sends packages as blocks (and file by file, as servers always have) */
interface Pkg { gameId: number; manifest: Manifest; data: Record<string, Bytes>; blocks: boolean }
const pkgs = new Map<number, Pkg>();
function pkg(id: number, files: Record<string, Bytes>, over: Partial<Manifest> = {}, blocks = true): Manifest {
  const list = Object.entries(files).map(([path, d]) => ({ path, size: d.length, sha256: sha(d) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest: Manifest = { schema: 1, name: "Blocky", slug: "blocky", version: "1.0", launch: { exe: "game.exe", args: "", cwd: "" }, prerequisites: [], files: list, totalSize: list.reduce((a, f) => a + f.size, 0), ...over };
  pkgs.set(id, { gameId: 70, manifest, data: files, blocks });
  return manifest;
}
/** the digest as the server makes it, written out here so the launcher's own is held against it */
const digestOf = (m: Manifest) => { const h = createHash("sha256"); for (const f of m.files) h.update(`${f.path}\0${f.size}\0${f.sha256}\n`); return h.digest("hex"); };
function indexOf(p: Pkg): Bytes {
  const hashes: Buffer[] = [];
  for (const f of p.manifest.files) for (let i = 0; i < nBlocks(f.size); i++) hashes.push(createHash("sha256").update(p.data[f.path]!.subarray(i * BLOCK, Math.min(f.size, (i + 1) * BLOCK))).digest());
  const head = Buffer.alloc(64);
  head.write("AHOYBLK1", 0, "latin1"); head.writeUInt32LE(BLOCK, 8); head.writeUInt32LE(p.manifest.files.length, 12); head.writeUInt32LE(hashes.length, 16); head.writeDoubleLE(Date.now(), 24);
  Buffer.from(digestOf(p.manifest), "hex").copy(head, 32);
  return new Uint8Array(Buffer.concat([head, ...hashes]));
}

/** what the server was asked, and how it misbehaves on request */
const seen = { posts: [] as { id: number; want: number[][] }[], files: [] as string[], index: 0 };
const knobs = {
  /** end the stream after this many blocks, once */
  cutAfter: null as number | null,
  /** flip a byte in the next N blocks sent (Infinity: always) */
  corrupt: 0,
  /** send an error frame instead of this block (counted over the whole run) */
  errorAt: null as number | null,
  postStatus: null as number | null, indexStatus: null as number | null,
  /** called with the count of blocks sent so far, before each one */
  onBlock: null as null | ((sent: number) => void | Promise<void>),
  /** what to send instead of a block: a frame longer than a block, or one that unpacks to more than a block */
  hostile: null as null | "long" | "bomb",
};
let sent = 0;
const blocksAsked = () => seen.posts.reduce((n, p) => n + p.want.reduce((m, w) => m + w[2]!, 0), 0);

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const auth = new Headers(init?.headers).get("authorization");
  if (auth !== `Bearer ${KEY}`) return new Response(JSON.stringify({ error: "sign in" }), { status: 401 });
  const m = /^\/api\/v1\/package\/(\d+)(\/blocks|\/files\/(.+))?$/.exec(u.pathname);
  const p = m ? pkgs.get(Number(m[1])) : undefined;
  if (!m || !p) return new Response("{}", { status: 404 });
  const id = Number(m[1]);
  if (!m[2]) return Response.json({ item: { id, gameId: p.gameId, name: p.manifest.name, version: p.manifest.version, size: p.manifest.totalSize, manifest: p.manifest, blocks: p.blocks ? { size: BLOCK, count: p.manifest.files.reduce((n, f) => n + nBlocks(f.size), 0), digest: digestOf(p.manifest) } : null } });
  if (m[3]) {                                                              // one file, with Range
    const rel = decodeURIComponent(m[3]), d = p.data[rel];
    seen.files.push(rel);
    if (!d) return new Response("{}", { status: 404 });
    const r = /bytes=(\d+)-(\d*)/.exec(new Headers(init?.headers).get("range") ?? "");
    if (!r) return new Response(d);
    const a = Number(r[1]), b = r[2] ? Number(r[2]) : d.length - 1;
    return new Response(d.slice(a, b + 1), { status: 206, headers: { "content-range": `bytes ${a}-${b}/${d.length}` } });
  }
  if ((init?.method ?? "GET") === "GET") {
    seen.index++;
    return knobs.indexStatus ? new Response("{}", { status: knobs.indexStatus }) : new Response(indexOf(p));
  }
  const body = JSON.parse(String(init?.body)) as { digest: string; want: number[][] };
  seen.posts.push({ id, want: body.want });
  if (knobs.postStatus) return new Response(JSON.stringify({ error: "the engine's own words", digest: "f".repeat(64) }), { status: knobs.postStatus });
  if (body.digest !== digestOf(p.manifest)) return new Response(JSON.stringify({ digest: digestOf(p.manifest) }), { status: 409 });
  const todo: [number, number][] = [];
  for (const [fi, first, count] of body.want) for (let i = first!; i < first! + count!; i++) todo.push([fi!, i]);
  let at = 0, cut = knobs.cutAfter;
  const pieces: Uint8Array[] = [];
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (init?.signal?.aborted) { c.error(new Error("aborted")); return; }
      if (pieces.length) { c.enqueue(pieces.shift()!); return; }
      if (at >= todo.length) { c.close(); return; }
      if (cut != null && at >= cut) { knobs.cutAfter = null; c.close(); return; }
      await knobs.onBlock?.(sent);
      if (init?.signal?.aborted) { c.error(new Error("aborted")); return; }
      const [fi, bi] = todo[at++]!;
      const f = p.manifest.files[fi]!;
      let raw: Uint8Array = p.data[f.path]!.subarray(bi * BLOCK, Math.min(f.size, (bi + 1) * BLOCK));
      const frame = (kind: number, payload: Uint8Array) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32LE(payload.byteLength, 1); return Buffer.concat([h, payload]); };
      let out: Buffer;
      if (knobs.errorAt != null && sent === knobs.errorAt) { out = frame(255, Buffer.from("/library/secret/path is not the file that was indexed any more")); at = todo.length; }
      else if (knobs.hostile === "long") out = frame(0, Buffer.alloc(raw.byteLength + 1));
      else if (knobs.hostile === "bomb") out = frame(1, zstdCompressSync(Buffer.alloc(8 * BLOCK)));
      else {
        if (knobs.corrupt > 0) { knobs.corrupt--; raw = Uint8Array.from(raw); raw[0] = raw[0]! ^ 0xff; }
        const z = raw.byteLength >= 256 ? zstdCompressSync(raw) : null;
        out = z && z.byteLength < raw.byteLength * 0.97 ? frame(1, z) : frame(0, raw);
      }
      sent++;
      // in pieces that fit no frame: the launcher puts them together again
      for (let o = 0; o < out.byteLength; o += 70_001) pieces.push(out.subarray(o, Math.min(out.byteLength, o + 70_001)));
      c.enqueue(pieces.shift()!);
    },
  });
  return new Response(stream, { headers: { "content-type": "application/octet-stream" } });
}) as typeof fetch;

const root = mkdtempSync(join(tmpdir(), "ahoy-blocks-"));
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* a scanner holds it */ } });
let dataDir = "", library = "", events: EngineEvent[] = [];
const phases = () => events.filter(e => e.type === "install").map(e => (e as any).phase as string).filter((p, i, a) => p !== a[i - 1]);
const lastInstall = () => events.filter(e => e.type === "install").at(-1) as Extract<EngineEvent, { type: "install" }>;
function engine(blocks: ConstructorParameters<typeof Engine>[0]["blocks"] = { sleep: async () => {} }) {
  return new Engine({ dataDir, serverUrl: () => "http://ahoy.test", token: () => KEY, onEvent: e => events.push(e), version: "0.11.0", fetchImpl: fakeFetch, blocks });
}
beforeEach(() => {
  dataDir = mkdtempSync(join(root, "data-")); library = mkdtempSync(join(root, "lib-")); events = [];
  pkgs.clear(); seen.posts = []; seen.files = []; seen.index = 0; sent = 0;
  Object.assign(knobs, { cutAfter: null, corrupt: 0, errorAt: null, postStatus: null, indexStatus: null, onBlock: null, hostile: null });
});
/** the install folder holds exactly these files, byte for byte */
function holds(dir: string, files: Record<string, Uint8Array>) {
  const found: string[] = [];
  const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(join(d, e.name), r); else found.push(r); } };
  walk(dir, "");
  expect(found.sort()).toEqual(Object.keys(files).sort());
  for (const [rel, d] of Object.entries(files)) expect([rel, sha(readFileSync(join(dir, rel)))]).toEqual([rel, sha(d)]);
}

const GAME = (): Record<string, Bytes> => ({
  "game.exe": noise(2 * BLOCK + 4321),
  "data/big.pak": noise(5 * BLOCK),
  "data/script.txt": text(3 * BLOCK + 10),
  "data/empty.cfg": new Uint8Array(),
  "readme.txt": new Uint8Array(Buffer.from("enjoy")),
});

describe("the launcher's own reading of the server's words", () => {
  test("the digest of a file list is the server's; what a package says of its blocks is taken only when it is whole", () => {
    const m = pkg(1, GAME());
    expect(filesDigest(m.files)).toBe(digestOf(m));
    expect(blocksInfoOf({ size: BLOCK, count: 12, digest: "a".repeat(64) })).toEqual({ size: BLOCK, count: 12, digest: "a".repeat(64) });
    for (const odd of [null, undefined, "yes", {}, { size: 65536, count: 1, digest: "a".repeat(64) }, { size: BLOCK, count: -1, digest: "a".repeat(64) }, { size: BLOCK, count: 1.5, digest: "a".repeat(64) }, { size: BLOCK, count: 1, digest: "A".repeat(64) }, { size: BLOCK, count: 1 }]) expect(blocksInfoOf(odd)).toBeNull();
  });
});

describe("a game installed as blocks", () => {
  test("one request for the whole game, none for a file by itself: every file is there, byte for byte", async () => {
    const files = GAME();
    for (let i = 0; i < 400; i++) files[`assets/${i % 20}/tile-${i}.dat`] = noise(700 + (i % 9) * 311);   // many small files
    const m = pkg(1, files);
    const g = await engine().install(1, library);
    holds(g.path, files);
    expect(seen.files).toEqual([]);                                                       // no file was asked for by its name
    expect(seen.index).toBe(1);
    expect(seen.posts.length).toBe(1);                                                    // 405 files: one request
    expect(blocksAsked()).toBe(m.files.reduce((n, f) => n + nBlocks(f.size), 0));
    expect(phases()).toEqual(["downloading", "finishing", "done"]);                       // nothing read again to check it
    expect(lastInstall()).toMatchObject({ phase: "done", progress: 1, total: m.totalSize });
    expect((await engine().installed()).map(x => [x.slug, x.packageId])).toEqual([["blocky", 1]]);
    expect(readdirSync(join(dataDir, "installed-blocks")).sort()).toEqual(["blocky.blk", "blocky.json"]);
  });

  test("a big game goes over several streams, each request about 32 MiB of it at most", async () => {
    const files = { "game.exe": noise(BLOCK), "data/a.pak": noise(40 * BLOCK), "data/b.pak": text(30 * BLOCK) };
    pkg(1, files);
    const g = await engine().install(1, library);
    holds(g.path, files);
    expect(seen.posts.length).toBe(3);                                                    // 71 MiB: 32 + 32 + 7
    for (const p of seen.posts) expect(p.want.reduce((n, w) => n + w[2]!, 0)).toBeLessThanOrEqual(32);
    expect(blocksAsked()).toBe(71);
  });

  test("a save or a settings file already on this PC is left as it is", async () => {
    const files: Record<string, Bytes> = { ...GAME(), "saves/slot1.sav": noise(3000), "settings.ini": text(200) };
    pkg(1, files, { keep: ["saves/**"], seed: ["settings.ini"] });
    mkdirSync(join(library, "blocky", "saves"), { recursive: true });
    writeFileSync(join(library, "blocky", "saves", "slot1.sav"), "my own progress");
    writeFileSync(join(library, "blocky", "settings.ini"), "volume=3");
    const g = await engine().install(1, library);
    expect(readFileSync(join(g.path, "saves", "slot1.sav"), "utf8")).toBe("my own progress");
    expect(readFileSync(join(g.path, "settings.ini"), "utf8")).toBe("volume=3");
    expect(sha(readFileSync(join(g.path, "game.exe")))).toBe(sha(files["game.exe"]!));
  });
});

describe("what is on disk already is not fetched", () => {
  /** version 2: one block of the big file changed, the script longer, a file gone, a file new; the rest as it was */
  function two(v1: Record<string, Bytes>): Record<string, Bytes> {
    const big = Uint8Array.from(v1["data/big.pak"]!); big.set(noise(1000), 3 * BLOCK + 5);          // block 3 of 5
    const v2: Record<string, Bytes> = { ...v1, "data/big.pak": big, "data/script.txt": new Uint8Array(Buffer.concat([v1["data/script.txt"]!, text(BLOCK)])), "data/new.bin": noise(BLOCK + 9) };
    delete v2["readme.txt"];
    return v2;
  }
  // big.pak block 3; script.txt's last block of before (its end moved) and the one after it; new.bin's two
  const CHANGED = 1 + 2 + 2;

  test("an update brings only the blocks that changed, and reads nothing to find them", async () => {
    const v1 = GAME(), v2 = two(v1);
    pkg(1, v1);
    const e = engine();
    await e.install(1, library);
    seen.posts = []; events = [];
    pkg(2, v2, { version: "1.1" });
    const g = await e.install(2, library);
    holds(g.path, v2);                                                                    // the file the new copy lacks is gone
    expect(blocksAsked()).toBe(CHANGED);
    expect(phases()).toEqual(["downloading", "finishing", "done"]);                       // no file was read to compare: the launcher knew what it had
    expect(seen.files).toEqual([]);
    expect((await e.installed())[0]).toMatchObject({ packageId: 2, version: "1.1" });
  });

  test("without what the launcher kept, the files themselves are read, and the same blocks come", async () => {
    const v1 = GAME(), v2 = two(v1);
    pkg(1, v1);
    await engine().install(1, library);
    rmSync(join(dataDir, "installed-blocks"), { recursive: true });
    seen.posts = []; events = [];
    pkg(2, v2, { version: "1.1" });
    const g = await engine().install(2, library);
    holds(g.path, v2);
    expect(blocksAsked()).toBe(CHANGED);
    expect(phases()).toEqual(["downloading", "verifying", "downloading", "finishing", "done"]);
  });

  test("a file changed on this PC since is not believed: it is read, and what differs is brought again", async () => {
    const v1 = GAME();
    pkg(1, v1);
    const e = engine();
    const g = await e.install(1, library);
    // the player's own edit of one file (another size), and a patch in place (the same size, a later time)
    writeFileSync(join(g.path, "readme.txt"), "ENJOY it, I changed this");
    const exe = readFileSync(join(g.path, "game.exe")); exe[BLOCK + 7] = exe[BLOCK + 7]! ^ 1;
    writeFileSync(join(g.path, "game.exe"), exe);
    utimesSync(join(g.path, "game.exe"), new Date(), new Date(Date.now() + 60_000));
    seen.posts = [];
    await e.install(1, library);                                                          // the same package again: a repair
    holds(g.path, v1);
    expect(blocksAsked()).toBe(2);                                                        // readme's one block, game.exe's second
  });

  test("a download that was stopped goes on where it was", async () => {
    const files = { "game.exe": noise(BLOCK), "data/big.pak": noise(12 * BLOCK) };
    const m = pkg(1, files);
    const all = m.files.reduce((n, f) => n + nBlocks(f.size), 0);
    const e = engine({ streams: 1, requestBytes: 4 * BLOCK, sleep: async () => {} });
    knobs.onBlock = n => { if (n === 6) e.cancel(1); };
    await expect(e.install(1, library)).rejects.toThrow("cancelled");
    expect(lastInstall()).toMatchObject({ phase: "cancelled" });
    expect(await e.installed()).toEqual([]);
    const got = sent;
    expect(got).toBeGreaterThanOrEqual(6); expect(got).toBeLessThan(all);
    knobs.onBlock = null; seen.posts = []; events = [];
    const g = await e.install(1, library);
    holds(g.path, files);
    expect(blocksAsked()).toBe(all - 6);                                                  // the six that were in place are not asked for again
    expect(phases()).toEqual(["downloading", "finishing", "done"]);                       // nor read: the launcher wrote down what it had
  });

  test("after a crash (nothing written down), what is on disk is read and still not fetched again", async () => {
    const files = { "game.exe": noise(BLOCK), "data/big.pak": noise(12 * BLOCK) };
    const m = pkg(1, files);
    const all = m.files.reduce((n, f) => n + nBlocks(f.size), 0);
    const e = engine({ streams: 1, requestBytes: 4 * BLOCK, sleep: async () => {} });
    knobs.onBlock = n => { if (n === 6) e.cancel(1); };
    await expect(e.install(1, library)).rejects.toThrow("cancelled");
    rmSync(join(dataDir, "installed-blocks"), { recursive: true, force: true });
    knobs.onBlock = null; seen.posts = [];
    const g = await engine().install(1, library);
    holds(g.path, files);
    expect(blocksAsked()).toBe(all - 6);
  });
});

describe("what arrives is checked, and a broken stream is picked up", () => {
  test("a stream that ends early is asked for again from the block it broke at", async () => {
    const files = { "game.exe": noise(BLOCK), "data/big.pak": noise(9 * BLOCK) };
    pkg(1, files);
    knobs.cutAfter = 4;
    const g = await engine({ streams: 1, sleep: async () => {} }).install(1, library);
    holds(g.path, files);
    expect(seen.posts.map(p => p.want)).toEqual([[[0, 0, 9], [1, 0, 1]], [[0, 4, 5], [1, 0, 1]]]);
    expect(phases()).toEqual(["downloading", "finishing", "done"]);
  });

  test("a block that is not the one the index names is never written: it is asked for once more, alone", async () => {
    const files = { "game.exe": noise(3 * BLOCK) };
    pkg(1, files);
    knobs.corrupt = 1;
    const g = await engine({ streams: 1, sleep: async () => {} }).install(1, library);
    holds(g.path, files);
    expect(seen.posts.map(p => p.want)).toEqual([[[0, 0, 3]], [[0, 0, 1]]]);
  });

  test("a block that never checks is never written: the game comes file by file instead, held against the manifest", async () => {
    const files = { "game.exe": noise(3 * BLOCK), "data/more.bin": noise(BLOCK + 3) };
    pkg(1, files);
    knobs.corrupt = Infinity;                                                             // the server's blocks are not what its index names
    const e = engine({ streams: 1, sleep: async () => {} });
    const g = await e.install(1, library);
    holds(g.path, files);
    expect(seen.posts.length).toBe(2);                                                    // asked once, the block that failed once more, then no more blocks
    expect(seen.files.sort()).toEqual(["data/more.bin", "game.exe"]);
    expect(events.some(ev => ev.type === "install" && ev.phase === "failed")).toBe(false);
    expect(phases()).toEqual(["downloading", "verifying", "finishing", "done"]);          // file by file checks every file at the end, as it always did
    expect(existsSync(join(dataDir, "installed-blocks", "blocky.json"))).toBe(false);    // and nothing is kept of blocks that were not right
  });

  test("a file the server says it cannot send as blocks comes file by file; the server's own words stay on the server", async () => {
    const files = { "game.exe": noise(3 * BLOCK) };
    pkg(1, files);
    knobs.errorAt = 1;
    const g = await engine().install(1, library);
    holds(g.path, files);
    expect(seen.files).toEqual(["game.exe"]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(lastInstall().phase).toBe("done");
  });

  test("a package whose files changed on the server while it was downloading stops, and says so", async () => {
    pkg(1, { "game.exe": noise(3 * BLOCK) });
    knobs.postStatus = 409;
    await expect(engine().install(1, library)).rejects.toThrow("the game changed on the server");
    expect(JSON.stringify(events)).not.toContain("engine's own words");
  });

  test("something that is not a block is not taken for one (a frame longer than a block, one that unpacks to more): file by file instead", async () => {
    for (const how of ["long", "bomb"] as const) {
      pkgs.clear(); events = []; seen.posts = []; seen.files = [];
      const files = { "game.exe": noise(2 * BLOCK) };
      pkg(1, files);
      knobs.hostile = how;
      dataDir = mkdtempSync(join(root, "data-"));
      const lib = mkdtempSync(join(root, "lib-"));
      const g = await engine({ streams: 1, retries: 2, sleep: async () => {} }).install(1, lib);
      holds(g.path, files);
      expect(seen.posts.length).toBe(1);                                                  // not asked again and again
      expect(seen.files).toEqual(["game.exe"]);
    }
  });

  test("a line that stays down ends the install: file by file would not get through either", async () => {
    pkg(1, { "game.exe": noise(3 * BLOCK) });
    knobs.postStatus = 503;
    const e = engine({ streams: 2, retries: 2, sleep: async () => {} });
    await expect(e.install(1, library)).rejects.toThrow("503");
    expect(lastInstall().phase).toBe("failed");
    expect(seen.posts.length).toBeGreaterThanOrEqual(3);                                  // tried again, then given up
    expect(seen.files).toEqual([]);
  });

  test("signed out: said as that", async () => {
    pkg(1, { "game.exe": noise(BLOCK) });
    const e = new Engine({ dataDir, serverUrl: () => "http://ahoy.test", token: () => "wrong", onEvent: ev => events.push(ev), version: "0.11.0", fetchImpl: fakeFetch });
    await expect(e.install(1, library)).rejects.toThrow("signed out");
  });
});

describe("a server that cannot send blocks is asked file by file, as before", () => {
  test("a package that says nothing of blocks", async () => {
    const files = GAME();
    pkg(1, files, {}, false);
    const g = await engine().install(1, library);
    holds(g.path, files);
    expect(seen.posts).toEqual([]); expect(seen.index).toBe(0);
    expect(seen.files.length).toBeGreaterThanOrEqual(4);                                 // every file that has bytes, by its name
    expect(phases()).toEqual(["downloading", "verifying", "finishing", "done"]);
  });

  test("a package that says blocks, on a server whose index is gone, or that no longer knows the route", async () => {
    for (const set of [() => { knobs.indexStatus = 404; }, () => { knobs.postStatus = 404; }, () => { knobs.postStatus = 501; }]) {
      pkgs.clear(); seen.posts = []; seen.files = []; events = [];
      Object.assign(knobs, { indexStatus: null, postStatus: null });
      const files = GAME();
      pkg(1, files);
      set();
      dataDir = mkdtempSync(join(root, "data-"));                                           // a PC that has not got the game
      const lib = mkdtempSync(join(root, "lib-"));
      const g = await engine().install(1, lib);
      holds(g.path, files);
      expect(seen.files.length).toBeGreaterThanOrEqual(4);                                 // every file that has bytes, by its name
      expect(events.some(e => e.type === "install" && e.phase === "failed")).toBe(false);   // nothing is said of the detour
      expect(lastInstall().phase).toBe("done");
    }
  });

  test("an index that is another file list's is not used", async () => {
    const files = GAME();
    const m = pkg(1, files);
    // the package names one list, its index is for another (a file's sum differs)
    const other = { ...pkgs.get(1)!, manifest: { ...m, files: m.files.map((f, i) => (i ? f : { ...f, sha256: "0".repeat(64) })) } };
    const real = pkgs.get(1)!;
    pkgs.set(1, { ...real, manifest: real.manifest });
    const originalIndex = indexOf(other);
    const fetchOther = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname === "/api/v1/package/1/blocks" && (init?.method ?? "GET") === "GET") return new Response(originalIndex);
      return fakeFetch(url as string, init);
    }) as typeof fetch;
    const e = new Engine({ dataDir, serverUrl: () => "http://ahoy.test", token: () => KEY, onEvent: ev => events.push(ev), version: "0.11.0", fetchImpl: fetchOther });
    const g = await e.install(1, library);
    holds(g.path, files);
    expect(seen.posts).toEqual([]);
    expect(seen.files.length).toBeGreaterThanOrEqual(4);                                 // every file that has bytes, by its name
  });

  test("a launcher told to (blocks: false) asks file by file whatever the server offers", async () => {
    const files = GAME();
    pkg(1, files);
    const g = await engine(false).install(1, library);
    holds(g.path, files);
    expect(seen.posts).toEqual([]); expect(seen.index).toBe(0);
  });

  test("a game installed file by file after one taken as blocks keeps nothing of the blocks", async () => {
    const files = GAME();
    pkg(1, files);
    const e = engine();
    await e.install(1, library);
    expect(existsSync(join(dataDir, "installed-blocks", "blocky.json"))).toBe(true);
    pkg(2, { ...files, "extra.bin": noise(5000) }, { version: "1.1" }, false);
    await e.install(2, library);
    expect(existsSync(join(dataDir, "installed-blocks", "blocky.json"))).toBe(false);
    expect(existsSync(join(dataDir, "installed-blocks", "blocky.blk"))).toBe(false);
  });
});

describe("uninstalling", () => {
  test("what the launcher kept of the game's blocks goes with it", async () => {
    pkg(1, GAME());
    const e = engine();
    const g = await e.install(1, library);
    await e.uninstall("blocky");
    expect(existsSync(g.path)).toBe(false);
    expect(readdirSync(join(dataDir, "installed-blocks"))).toEqual([]);
  });
});
