import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, chmodSync, openSync, closeSync, symlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  Engine, KEEP_DIR, fillInstall, globMatcher, launchCommand, manifestSource, mergeEnv, pathProblem, quoteArg, safeSlug, shortcutName, versionAtLeast, writeAtomic,
  type EngineEvent, type InstalledGame, type Manifest, type ShortcutOpts, type SpawnGame,
} from "../src/engine";

/* a fake Ahoy server: packages held in memory, served with Range support behind a session token like the real one */
const KEY = "deadbeefcafe";
const rnd = (n: number) => { const b = new Uint8Array(n); for (let i = 0; i < n; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(n, i + 65536))); return b; };
const enc = (s: string) => new TextEncoder().encode(s);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** bytes the fake server can answer with (an ArrayBuffer-backed view, as a Response body must be) */
type Bytes = Uint8Array<ArrayBuffer>;
interface Pkg { gameId: number | null; manifest: Manifest; data: Record<string, Bytes> }
const pkgs = new Map<number, Pkg>();
/** a package on the fake server; `over` replaces manifest fields (the file list too, for packages that never get fetched) */
function pkg(id: number, files: Record<string, Bytes | string>, over: Partial<Manifest> = {}, gameId: number | null = 30): Manifest {
  const data = Object.fromEntries(Object.entries(files).map(([p, d]) => [p, typeof d === "string" ? enc(d) : d]));
  const list = Object.entries(data).map(([path, d]) => ({ path, size: d.length, sha256: sha(d) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest: Manifest = {
    schema: 1, name: "Zelda", slug: "zelda", version: "1.0", launch: { exe: "Game.exe", args: "", cwd: "" }, prerequisites: [],
    files: list, totalSize: list.reduce((a, f) => a + f.size, 0), ...over,
  };
  pkgs.set(id, { gameId, manifest, data });
  return manifest;
}

// an installed-game folder as an import makes it (an old-style manifest: no argv, no keep, no requires)
const hadesFiles = { "Hades.exe": rnd(300_000), "x64/data.pak": rnd(900_000), "readme.txt": enc("hi"), "_CommonRedist/vc_redist.x64.exe": rnd(10_000) };
const manifest = pkg(7, hadesFiles, { name: "Hades", slug: "hades", version: "1.38", launch: { exe: "Hades.exe", args: "", cwd: "" }, prerequisites: [{ kind: "vcredist", path: "_CommonRedist/vc_redist.x64.exe", args: "/quiet /norestart" }] }, 4);
pkg(9, { "PPSA01342.pkg": rnd(10_000) }, { name: "Demon's Souls", slug: "demons-souls", version: null, launch: { exe: "PPSA01342.pkg", args: "", cwd: "" }, kind: "rom", platform: "ps5" }, 5);

// ways as ludarr builds them: a recomp that keeps its saves in its own folder (portable), in several versions
const zelda = (id: number, version: string, exe = rnd(6000), over: Partial<Manifest> = {}) =>
  pkg(id, { "Zelda64Recompiled.exe": exe, "portable.txt": "" }, {
    name: "Zelda", slug: "zelda", version, kind: "recomp", keep: ["saves/**", "*.json"], requires: { launcher: "0.10.0" },
    launch: { exe: "Zelda64Recompiled.exe", args: "", cwd: "", argv: [] }, ...over,
  }, 40);
zelda(61, "1.0");
zelda(62, "1.1");
zelda(63, "1.2", rnd(1_000_000));                                        // big enough to cancel mid-way
zelda(64, "1.3", rnd(6000), { launch: { exe: "Zelda64Recompiled.exe", args: "", cwd: "", argv: [], env: { RECOMP_LOG: "{install}/log.txt" } } });
// argv with {install} in it
pkg(31, { "Zelda64Recompiled.exe": rnd(5000), "roms/mm.us.z64": rnd(4000), "portable.txt": "" }, {
  name: "Zelda 64", slug: "zelda64", kind: "recomp", requires: { launcher: "0.10.0" },
  launch: { exe: "Zelda64Recompiled.exe", args: "", cwd: "", argv: ["--rom", "{install}/roms/mm.us.z64", "{install}", "--flag", "a b"] },
});
// env and an {install} working folder
pkg(32, { "bin/sm64.exe": rnd(2000), "data/base.bin": rnd(100) }, {
  name: "SM64", slug: "sm64", kind: "port", requires: { launcher: "0.10.0" },
  launch: { exe: "bin/sm64.exe", args: "", cwd: "{install}/bin", argv: ["--skip-update-check"], env: { SM64_DATA: "{install}/data", AHOY_ENGINE_TEST: "on" } },
});
// a script as the program, with a file name that would be a command to a shell
pkg(71, { "run.bat": "@echo off\r\n%*\r\n", "roms/a&calc.cmd": "x" }, {
  name: "Scripted", slug: "scripted", kind: "emulated", launch: { exe: "run.bat", args: "", cwd: "", argv: ["{install}/roms/a&calc.cmd"] },
});

let corrupt = false;
let requests = 0;
const hits: string[] = [];                                               // "<package id>:<path>" of every file request
const asks: number[] = [];                                               // the packages Play asked the start of
const ranged = (req: Request, d: Bytes) => {
  const r = /bytes=(\d+)-(\d*)/.exec(req.headers.get("range") ?? "");
  if (!r) return new Response(d, { headers: { "accept-ranges": "bytes", "content-length": String(d.length) } });
  const start = Number(r[1]), end = r[2] ? Number(r[2]) : d.length - 1;
  return new Response(d.subarray(start, end + 1), { status: 206, headers: { "content-range": `bytes ${start}-${end}/${d.length}`, "content-length": String(end - start + 1), "accept-ranges": "bytes" } });
};
const srv = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  async fetch(req) {
    const u = new URL(req.url); requests++;
    if (u.pathname === "/api/health") return Response.json({ ok: true, version: "0.1.0" });
    if (req.headers.get("authorization") !== `Bearer ${KEY}`) return Response.json({ error: "sign in first" }, { status: 401 });
    // how a package starts now, as the Ahoy server answers it from the engine (the start, its stamp, what it needs, its kind)
    const l = /^\/api\/v1\/package\/(\d+)\/launch$/.exec(u.pathname);
    if (l) {
      asks.push(Number(l[1]));
      const p = pkgs.get(Number(l[1]));
      if (!p) return Response.json({ error: "That game couldn't be found" }, { status: 404 });
      const launch = p.manifest.launch as Manifest["launch"] | null;
      return Response.json({ launch, rev: launch?.rev ?? null, requires: p.manifest.requires ?? null, kind: p.manifest.kind ?? "native" });
    }
    const m = /^\/api\/v1\/package\/(\d+)(?:\/files\/(.+))?$/.exec(u.pathname);
    const p = m ? pkgs.get(Number(m[1])) : undefined;
    if (!m || !p) return new Response("nope", { status: 404 });
    if (!m[2]) return Response.json({ item: { id: Number(m[1]), gameId: p.gameId, name: p.manifest.name, version: p.manifest.version, size: p.manifest.totalSize, manifest: p.manifest } });
    const rel = decodeURIComponent(m[2]);
    hits.push(`${m[1]}:${rel}`);
    if (corrupt && m[1] === "7" && rel === "x64/data.pak") return new Response(rnd(900_000).subarray(0, 100), { status: 206, headers: { "content-range": "bytes 0-99/900000" } });
    const d = p.data[rel];
    return d ? ranged(req, d) : new Response("nope", { status: 404 });
  },
});
/** temp folders this file makes, removed at the end */
const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { srv.stop(true); for (const d of made) rmSync(d, { recursive: true, force: true }); });
const serverUrl = `http://127.0.0.1:${srv.port}`;

let events: EngineEvent[] = [];
let lib: string, data: string, desk: string, engine: Engine;
const installers: string[][] = [];
/** games "started": what Play handed to spawn, and a child the test can end */
const spawned: { exe: string; args: string[]; opts: SpawnOptions; child: EventEmitter }[] = [];
const fakeSpawn: SpawnGame = (exe, args, opts) => {
  const child = Object.assign(new EventEmitter(), { pid: 4000 + spawned.length, unref() {} });
  spawned.push({ exe, args, opts, child });
  return child as unknown as ChildProcess;
};
/** a desktop as Electron's writeShortcutLink leaves it: one file per shortcut */
const links: { file: string; target: string; args: string; cwd: string; description: string }[] = [];
const desktop = (on: () => boolean = () => true): ShortcutOpts => ({
  enabled: on, dir: () => desk,
  write: (file, link) => { writeFileSync(file, JSON.stringify(link)); links.push({ file, ...link }); return true; },
  // readShortcutLink's target; a file it cannot read as a shortcut gives null
  read: file => { try { return JSON.parse(readFileSync(file, "utf8")).target ?? null; } catch { return null; } },
});
/** a shortcut the person made themselves, to a program somewhere else */
const theirs = (file: string, target = "D:\\Games\\elsewhere\\Game.exe") => writeFileSync(file, JSON.stringify({ target, args: "", cwd: "D:\\Games\\elsewhere" }));
/** is a file held by a running program (Windows refuses to open a program it runs for writing) */
const locked = async (file: string) => { try { await (await open(file, "r+")).close(); return false; } catch (e: any) { return e?.code === "EBUSY"; } };
const mk = (over: Partial<ConstructorParameters<typeof Engine>[0]> = {}) => new Engine({
  dataDir: data, serverUrl: () => serverUrl, token: () => KEY, version: "0.10.0", onEvent: e => events.push(e),
  runInstaller: async (exe, args) => { installers.push([exe, ...args]); return 0; }, spawnGame: fakeSpawn, segments: 2, ...over,
});
/** file requests stretched out, so an install can be cancelled half-way */
const slow: typeof fetch = (async (url: any, init?: RequestInit) => {
  const res = await fetch(url, init);
  if (!String(url).includes("/files/")) return res;
  return new Response(res.body!.pipeThrough(new TransformStream({ async transform(c, ctl) { for (let i = 0; i < c.length; i += 4096) { ctl.enqueue(c.subarray(i, i + 4096)); await Bun.sleep(2); } } })), { status: res.status, headers: res.headers });
}) as typeof fetch;
const writeSaves = (dir: string) => {
  mkdirSync(join(dir, "saves"), { recursive: true });
  writeFileSync(join(dir, "saves", "mm.sav"), "slot 1");
  writeFileSync(join(dir, "graphics.json"), '{"res":4}');
};
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const record = async (slug: string) => (await engine.installed()).find(g => g.slug === slug);
/** wait for a condition (a download under way) rather than a fixed time, which a busy disk can outlast */
const until = async (ok: () => boolean, ms = 10_000) => {
  for (const t = Date.now(); !ok(); await Bun.sleep(5)) if (Date.now() - t > ms) throw new Error("timed out waiting");
};

beforeEach(() => {
  events = []; installers.length = 0; spawned.length = 0; links.length = 0; hits.length = 0; asks.length = 0; corrupt = false; requests = 0;
  // every library folder has a space in its path, as Windows user folders often do
  lib = tmp("ahoy lib-"); data = tmp("ahoy-data-"); desk = tmp("ahoy-desk-");
  engine = mk();
});

describe("manifest source", () => {
  test("walks the manifest like a directory tree and sends the key with every file", async () => {
    const src = manifestSource(manifest, `${serverUrl}/api/v1/package/7/files/`, { "X-Api-Key": KEY });
    expect((await src.list("hades")).map(e => `${e.name}${e.isDir ? "/" : ""}`)).toEqual(["Hades.exe", "_CommonRedist/", "readme.txt", "x64/"]);
    expect(await src.list("hades/x64")).toEqual([{ name: "data.pak", size: 900_000, isDir: false }]);
    expect(await src.stat("hades/x64/data.pak")).toEqual({ size: 900_000, isDir: false });
    expect(await src.stat("hades/x64")).toEqual({ size: 0, isDir: true });
    expect(await src.request("hades/x64/data.pak")).toEqual({ url: `${serverUrl}/api/v1/package/7/files/x64/data.pak`, headers: { "X-Api-Key": KEY } });
    await expect(src.stat("hades/nope")).rejects.toThrow(/not in the manifest/);
  });
});

describe("engine", () => {
  test("install: files land byte-exact, verified, prerequisites run, record saved, events in order", async () => {
    const g = await engine.install(7, lib);
    expect(g).toMatchObject({ slug: "hades", gameId: 4, packageId: 7, name: "Hades", version: "1.38", path: join(lib, "hades"), launch: manifest.launch, kind: "native", serverUrl });
    for (const [rel, bytes] of Object.entries(hadesFiles)) expect(sha(readFileSync(join(lib, "hades", rel)))).toBe(sha(bytes));
    expect(installers).toEqual([[join(lib, "hades", "_CommonRedist", "vc_redist.x64.exe"), "/quiet", "/norestart"]]);
    expect(await engine.installed()).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(data, "installed.json"), "utf8"))[0].slug).toBe("hades");
    const phases = [...new Set(events.filter(e => e.type === "install").map(e => (e as any).phase))];
    expect(phases).toEqual(["downloading", "verifying", "prerequisites", "finishing", "done"]);
    expect(events.at(-1)).toMatchObject({ type: "install", phase: "done", progress: 1, total: manifest.totalSize, gameId: 4 });
    expect(events.some(e => e.type === "installed-changed")).toBe(true);
  });
  test("a wrong key is refused with a sentence that says what to do", async () => {
    await expect(mk({ token: () => "nope" }).install(7, lib)).rejects.toThrow(/signed out/);
  });
  test("a file the server served wrong is fetched again and verified; a second install re-uses what is there", async () => {
    corrupt = true;
    const p = engine.install(7, lib);
    setTimeout(() => { corrupt = false; }, 50);
    await p;
    expect(sha(readFileSync(join(lib, "hades", "x64", "data.pak")))).toBe(sha(hadesFiles["x64/data.pak"]));
    const before = requests;
    await engine.install(7, lib);
    expect(requests - before).toBeLessThanOrEqual(2);                           // manifest only, nothing re-downloaded
  });
  test("cancel mid-way → cancelled event, nothing recorded; uninstall removes the folder", async () => {
    const e2 = mk({ fetchImpl: slow });
    const p = e2.install(7, lib);
    await until(() => e2.isInstalling(7));
    e2.cancel(7);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(events.some(e => e.type === "install" && (e as any).phase === "cancelled")).toBe(true);
    expect(await e2.installed()).toHaveLength(0);
    await engine.install(7, lib);
    expect(existsSync(join(lib, "hades", "Hades.exe"))).toBe(true);
    await engine.uninstall("hades");
    expect(existsSync(join(lib, "hades"))).toBe(false);
    expect(await engine.installed()).toHaveLength(0);
  });
  test("play refuses what is not installed or missing", async () => {
    await expect(engine.play("hades")).rejects.toThrow(/not installed/);
    await engine.install(7, lib);
    await import("node:fs/promises").then(fs => fs.rm(join(lib, "hades", "Hades.exe")));
    await expect(engine.play("hades")).rejects.toThrow(/missing executable/);
  });
  test("a console dump installs as it is (no prerequisites) and cannot be played", async () => {
    const g = await engine.install(9, lib);
    expect(g).toMatchObject({ kind: "rom", platform: "ps5", slug: "demons-souls" });
    expect(existsSync(join(lib, "demons-souls", "PPSA01342.pkg"))).toBe(true);
    expect(installers).toEqual([]);
    await expect(engine.play("demons-souls")).rejects.toThrow(/ps5 dump/);
    expect(spawned).toEqual([]);
  });
});

describe("refused before any download", () => {
  test("a package that needs a newer launcher fails with update-needed:, and nothing is fetched", async () => {
    pkg(33, { "Game.exe": rnd(100) }, { slug: "future", requires: { launcher: "0.11.0" } });
    await expect(engine.install(33, lib)).rejects.toThrow(/^update-needed: this game needs Ahoy 0\.11\.0 or newer \(this PC has 0\.10\.0\)$/);
    expect(hits).toEqual([]);
    expect(existsSync(join(lib, "future"))).toBe(false);
    expect(events.filter(e => e.type === "install")).toEqual([]);
    // a launcher that has that version installs the same package
    expect((await mk({ version: "0.11.0" }).install(33, lib)).slug).toBe("future");
  });
  test("a requirement this launcher meets installs; one it cannot read, or a launcher that does not know its version, does not", async () => {
    pkg(34, { "Game.exe": rnd(100) }, { slug: "older-need", requires: { launcher: "0.9.0" } });
    pkg(35, { "Game.exe": rnd(100) }, { slug: "odd-need", requires: { launcher: "soon" } });
    pkg(36, { "Game.exe": rnd(100) }, { slug: "no-need", requires: {} });
    expect((await engine.install(34, lib)).slug).toBe("older-need");
    expect((await engine.install(36, lib)).slug).toBe("no-need");
    await expect(engine.install(35, lib)).rejects.toThrow(/^update-needed: this game needs a newer Ahoy/);
    await expect(mk({ version: undefined }).install(34, lib)).rejects.toThrow(/^update-needed:/);
  });
  test("a package that names anything outside its folder, or has a broken shape, is refused", async () => {
    const f = (path: string) => ({ files: [{ path, size: 1, sha256: "0".repeat(64) }] });
    const L = (launch: Partial<Manifest["launch"]>) => ({ launch: { exe: "Game.exe", args: "", cwd: "", ...launch } as Manifest["launch"] });
    const cases: [string, Partial<Manifest>][] = [
      ["a slug that climbs", { slug: "../evil" }],
      ["a slug with a separator", { slug: "a\\b" }],
      ["the keep folder's name as the slug", { slug: KEEP_DIR }],
      ["a file that climbs", f("../outside.dll")],
      ["a file that climbs with backslashes", f("bin\\..\\..\\outside.dll")],
      ["a folder Windows reads as '..'", f("bin/.. /outside.dll")],
      ["an absolute file", f("/etc/evil")],
      ["a file on a drive", f("C:/Windows/evil.dll")],
      ["a file in a stream", f("Game.exe:evil")],
      ["a program outside", L({ exe: "..\\..\\Windows\\notepad.exe" })],
      ["a working folder outside", L({ cwd: "../.." })],
      ["a working folder beside {install}", L({ cwd: "{install}x" })],
      ["{install} in the middle of the working folder", L({ cwd: "bin/{install}" })],
      ["a setup file outside", { prerequisites: [{ kind: "vcredist", path: "../vc_redist.exe", args: "" }] }],
      ["a keep glob that climbs", { keep: ["../**"] }],
      ["an absolute seed glob", { seed: ["/abs/*.ini"] }],
      ["argv that is not a list", L({ argv: "x" as unknown as string[] })],
      ["an env name with '='", L({ env: { "A=B": "x" } })],
    ];
    for (const [i, [why, over]] of cases.entries()) {
      pkg(200 + i, { "Game.exe": rnd(100) }, { slug: `unsafe-${i}`, ...over });
      await expect(engine.install(200 + i, lib), why).rejects.toThrow(/not safe to install/);
    }
    expect(hits).toEqual([]);
    expect(readdirSync(lib)).toEqual([]);
  });
  test("a tampered record never starts a program outside its folder; an unsafe slug touches nothing", async () => {
    const dir = join(lib, "evil");
    mkdirSync(dir);
    const rec = (launch: Manifest["launch"]): InstalledGame => ({ slug: "evil", gameId: 1, packageId: 1, name: "Evil", version: null, path: dir, launch, kind: "native", platform: null, sizeBytes: 1, installedAt: 1, serverUrl });
    for (const launch of [
      { exe: "..\\..\\Windows\\System32\\notepad.exe", args: "", cwd: "" }, { exe: "C:\\Windows\\notepad.exe", args: "", cwd: "" },
      { exe: "Game.exe", args: "", cwd: "..\\.." }, { exe: "Game.exe", args: "", cwd: "{install}/../.." },
    ]) {
      writeFileSync(join(data, "installed.json"), JSON.stringify([rec(launch)]));
      await expect(engine.play("evil")).rejects.toThrow(/not inside its folder/);
    }
    expect(spawned).toEqual([]);
    // the page names the slug to uninstall: one that climbs never reaches a path
    writeFileSync(join(data, "evil.json"), "keep me");
    await engine.uninstall("../evil", { deleteSaves: true });
    expect(read(data, "evil.json")).toBe("keep me");
  });
});

describe("launch", () => {
  test("argv is used as it is, with {install} (a folder with a space in it) filled in", async () => {
    const g = await engine.install(31, lib);
    const dest = join(lib, "zelda64");
    expect(dest).toContain(" ");
    expect(g).toMatchObject({ kind: "recomp", path: dest, launch: { argv: ["--rom", "{install}/roms/mm.us.z64", "{install}", "--flag", "a b"] } });
    await engine.play("zelda64");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].exe).toBe(join(dest, "Zelda64Recompiled.exe"));
    // one item per argument, never split or joined; on Windows the filled-in values have backslashes throughout
    expect(spawned[0].args).toEqual(["--rom", join(dest, "roms", "mm.us.z64"), dest, "--flag", "a b"]);
    // no shell, the launcher's own environment
    expect(spawned[0].opts).toEqual({ cwd: dest, detached: true, stdio: "ignore", windowsHide: false });
    expect(events.at(-1)).toMatchObject({ type: "play", slug: "zelda64", running: true, pid: 4000 });
  });
  test("env goes over the launcher's own environment, {install} filled in, with an {install} working folder", async () => {
    await engine.install(32, lib);
    await engine.play("sm64");
    const dest = join(lib, "sm64"), s = spawned[0];
    expect(s.exe).toBe(join(dest, "bin", "sm64.exe"));
    expect(s.args).toEqual(["--skip-update-check"]);
    expect(s.opts.cwd).toBe(join(dest, "bin"));
    const env = s.opts.env as Record<string, string>;
    expect(env.SM64_DATA).toBe(join(dest, "data"));
    expect(env.AHOY_ENGINE_TEST).toBe("on");
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(SM64_DATA|AHOY_ENGINE_TEST)$/i.test(k)) expect(env[k]).toBe(v);
  });
  test("an old manifest starts exactly as before: args split on spaces, untouched, no env, its own folder", async () => {
    pkg(81, { "bin/Game.exe": rnd(500) }, { name: "Old", slug: "old-game", launch: { exe: "bin/Game.exe", args: "-windowed  -skipintro -dir={install}", cwd: "bin" } });
    await engine.install(81, lib);
    await engine.play("old-game");
    expect(spawned[0].exe).toBe(join(lib, "old-game", "bin", "Game.exe"));
    expect(spawned[0].args).toEqual(["-windowed", "-skipintro", "-dir={install}"]);
    expect(spawned[0].opts).toEqual({ cwd: join(lib, "old-game", "bin"), detached: true, stdio: "ignore", windowsHide: false });
  });
  test("every kind but a console dump plays (an unknown kind counts as native), and prerequisites run for each", async () => {
    const kinds = ["recomp", "port", "emulated", "something-new"];
    for (const [i, kind] of kinds.entries()) {
      pkg(91 + i, { "Game.exe": rnd(300), "redist/vc_redist.x64.exe": rnd(50) }, { slug: `kind-${i}`, kind: kind as Manifest["kind"], prerequisites: [{ kind: "vcredist", path: "redist/vc_redist.x64.exe", args: "/quiet" }] });
      const g = await engine.install(91 + i, lib);
      expect(g.kind).toBe(kind === "something-new" ? "native" : kind as InstalledGame["kind"]);
      await engine.play(g.slug);
    }
    expect(spawned).toHaveLength(4);
    expect(installers).toHaveLength(4);
  });
  test("a script handed an argument the command shell could read as a command is not installed, and never started", async () => {
    const e = mk({ shortcuts: desktop() });
    await expect(e.install(71, lib)).rejects.toThrow(/not safe to install: its start script is handed an argument that is more than a plain word/);
    expect(spawned).toEqual([]);
    expect(links).toEqual([]);
    expect(existsSync(join(lib, "scripted"))).toBe(false);
    // a name Windows would read as a script though it is not written as one is no start at all (tests/script-start.test.ts
    // holds the rest: what a script may be handed, and how the command shell gets it)
    for (const exe of ["go.bat.", "go.cmd  "]) expect(() => launchCommand({ path: lib, launch: { exe, args: "", cwd: "" } })).toThrow(/script/);
  });
  test("{install} fills in per platform; values without it stay exactly as they are", () => {
    expect(fillInstall("{install}/roms/x.z64", "C:\\Users\\me\\Games\\Ahoy\\zelda", "win32")).toBe("C:\\Users\\me\\Games\\Ahoy\\zelda\\roms\\x.z64");
    expect(fillInstall("--data={install}/d", "C:\\a b\\z", "win32")).toBe("--data=C:\\a b\\z\\d");
    expect(fillInstall("--data={install}/d", "/home/me/zelda", "linux")).toBe("--data=/home/me/zelda/d");
    expect(fillInstall("/fullscreen", "C:\\x", "win32")).toBe("/fullscreen");
    expect(fillInstall("-C", "C:\\x", "win32")).toBe("-C");
  });
  test("a variable in another case replaces the launcher's own on Windows", () => {
    expect(mergeEnv({ Path: "C:\\Windows", HOME: "h", Gone: undefined }, { PATH: "D:\\x", NEW: "1" }, true)).toEqual({ HOME: "h", PATH: "D:\\x", NEW: "1" });
    expect(mergeEnv({ Path: "a" }, { PATH: "b" }, false)).toEqual({ Path: "a", PATH: "b" });
  });
});

describe("updates", () => {
  test("an update deletes the old package's files the new one lacks, and keeps saves, settings and files the launcher did not install", async () => {
    const globs = { keep: ["memcards/**", "*.json"], seed: ["inis/*.ini"] };
    const launch = { exe: "pcsx2-qt.exe", args: "", cwd: "", argv: ["-batch", "{install}/games/okami.iso"] };
    pkg(41, {
      "pcsx2-qt.exe": rnd(3000), "old.dll": rnd(100), "data/old.pak": rnd(200), "inis/PCSX2.ini": "[UI]\nSetupWizardIncomplete=false\n",
      "inis/old.ini": "x=1", "default.json": "{}", "portable.ini": "",
    }, { name: "Okami", slug: "okami", kind: "emulated", launch, ...globs });
    const B = pkg(42, { "pcsx2-qt.exe": rnd(3100), "new.dll": rnd(150), "inis/PCSX2.ini": "[UI]\nSetupWizardIncomplete=false\nTheme=Dark\n", "inis/new.ini": "y=2", "portable.ini": "" },
      { name: "Okami", slug: "okami", kind: "emulated", launch, ...globs });
    pkg(43, { "pcsx2-qt.exe": rnd(3100), "inis/PCSX2.ini": "[UI]\n", "portable.ini": "" }, { name: "Okami", slug: "okami", kind: "emulated", launch, ...globs });
    await engine.install(41, lib);
    const dir = join(lib, "okami");
    // the program at work (a memory card, its settings), and the person's own file
    mkdirSync(join(dir, "memcards"));
    writeFileSync(join(dir, "memcards", "Mcd001.ps2"), "save");
    writeFileSync(join(dir, "settings.json"), '{"pad":1}');
    writeFileSync(join(dir, "inis", "PCSX2.ini"), "[UI]\nSetupWizardIncomplete=false\n[Pad1]\nType=DualShock2\n");
    writeFileSync(join(dir, "notes.txt"), "mine");
    hits.length = 0;
    expect((await engine.install(42, lib)).packageId).toBe(42);
    expect(existsSync(join(dir, "old.dll"))).toBe(false);
    expect(existsSync(join(dir, "data"))).toBe(false);                       // the folder it emptied goes too
    expect(read(dir, "inis", "PCSX2.ini")).toContain("DualShock2");          // a seed file on disk is never reset…
    expect(hits).not.toContain("42:inis/PCSX2.ini");                         // …nor fetched
    expect(read(dir, "inis", "new.ini")).toBe("y=2");                        // a seed file not there yet arrives
    for (const kept of ["inis/old.ini", "default.json", "settings.json", "memcards/Mcd001.ps2", "notes.txt"]) expect(existsSync(join(dir, kept)), kept).toBe(true);
    expect(sha(readFileSync(join(dir, "pcsx2-qt.exe")))).toBe(B.files.find(f => f.path === "pcsx2-qt.exe")!.sha256);
    expect(existsSync(join(dir, "new.dll"))).toBe(true);
    // installing the same package again deletes nothing
    await engine.install(42, lib);
    expect(existsSync(join(dir, "new.dll"))).toBe(true);
    // the next update judges by the files the last one installed
    await engine.install(43, lib);
    expect(existsSync(join(dir, "new.dll"))).toBe(false);
    for (const kept of ["inis/new.ini", "inis/old.ini", "notes.txt", "memcards/Mcd001.ps2"]) expect(existsSync(join(dir, kept)), kept).toBe(true);
    expect(read(dir, "inis", "PCSX2.ini")).toContain("DualShock2");
  });
  test("a game installed before 0.10.0 (no file list) loses nothing on update", async () => {
    const dir = join(lib, "legacy");
    mkdirSync(dir);
    writeFileSync(join(dir, "Game.exe"), "old exe");
    writeFileSync(join(dir, "old.dll"), "x");
    // what 0.9.0 wrote: no keep, seed, shortcut or file list
    writeFileSync(join(data, "installed.json"), JSON.stringify([{ slug: "legacy", gameId: 30, packageId: 51, name: "Legacy", version: null, path: dir, launch: { exe: "Game.exe", args: "", cwd: "" }, kind: "native", platform: null, sizeBytes: 10, installedAt: 1, serverUrl }]));
    pkg(52, { "Game.exe": rnd(500) }, { name: "Legacy", slug: "legacy" }, 30);
    expect((await engine.install(52, lib)).packageId).toBe(52);
    expect(existsSync(join(dir, "old.dll"))).toBe(true);
  });
  test("an update goes into the folder the game is in, even after the library folder changed", async () => {
    await engine.install(61, lib);
    writeSaves(join(lib, "zelda"));
    const lib2 = tmp("ahoy lib2-");
    const g = await engine.install(62, lib2);
    expect(g.path).toBe(join(lib, "zelda"));
    expect(read(lib, "zelda", "saves", "mm.sav")).toBe("slot 1");
    expect(readdirSync(lib2)).toEqual([]);
    // once that folder is gone, an install goes where it is told
    rmSync(join(lib, "zelda"), { recursive: true });
    expect((await engine.install(62, lib2)).path).toBe(join(lib2, "zelda"));
  });
});

describe("saves", () => {
  test("saves survive uninstall + reinstall", async () => {
    await engine.install(61, lib);
    const dir = join(lib, "zelda"), keep = join(lib, KEEP_DIR, "zelda");
    writeSaves(dir);
    await engine.uninstall("zelda");
    expect(existsSync(dir)).toBe(false);
    expect(read(keep, "saves", "mm.sav")).toBe("slot 1");
    expect(read(keep, "graphics.json")).toBe('{"res":4}');
    expect(existsSync(join(keep, "Zelda64Recompiled.exe"))).toBe(false);     // only what keep names
    expect(JSON.parse(read(data, "kept.json"))).toEqual([{ slug: "zelda", dir: keep, gameId: 40, serverUrl }]);   // and whose they are
    // a newer build of the same game takes them back
    await engine.install(62, lib);
    expect(read(dir, "saves", "mm.sav")).toBe("slot 1");
    expect(read(dir, "graphics.json")).toBe('{"res":4}');
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
    expect(JSON.parse(read(data, "kept.json"))).toEqual([]);
  });
  test("settings the package ships under a keep glob stay the player's: an update and an uninstall + reinstall never reset them", async () => {
    // Dolphin keeps its settings in User/, and the package ships a starting Dolphin.ini there (keep, not seed)
    const shipped = "[Interface]\nShowAnalytics=False\n";
    const dolphin = (id: number) => pkg(id, { "Dolphin.exe": rnd(4000 + id), "portable.txt": "", "User/Config/Dolphin.ini": shipped }, {
      name: "Mario Sunshine", slug: "mario-sunshine", kind: "emulated", keep: ["User/**"], seed: [], requires: { launcher: "0.10.0" },
      launch: { exe: "Dolphin.exe", args: "", cwd: "", argv: ["-b", "-e", "{install}/games/gms.iso"] },
    }, 50);
    dolphin(501); dolphin(502);
    await engine.install(501, lib);
    const ini = join(lib, "mario-sunshine", "User", "Config", "Dolphin.ini");
    expect(read(ini)).toBe(shipped);                                         // not on disk yet: it arrives
    const bound = shipped.replace("False", "True!");                         // what the emulator wrote, the same size as the shipped file
    writeFileSync(ini, bound);
    hits.length = 0;
    await engine.install(502, lib);                                          // an update
    expect(read(ini)).toBe(bound);
    expect(hits).not.toContain("502:User/Config/Dolphin.ini");               // neither fetched nor verified again
    const more = bound + "[Display]\nFullscreen=True\n";
    writeFileSync(ini, more);
    await engine.uninstall("mario-sunshine");
    expect(read(lib, KEEP_DIR, "mario-sunshine", "User", "Config", "Dolphin.ini")).toBe(more);
    hits.length = 0;
    await engine.install(502, lib);                                          // the reinstall puts it back and leaves it be
    expect(read(ini)).toBe(more);
    expect(hits).not.toContain("502:User/Config/Dolphin.ini");
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
    expect(JSON.parse(read(data, "kept.json"))).toEqual([]);
  });
  test("restoring never replaces a file that is already there", async () => {
    await engine.install(61, lib);
    writeSaves(join(lib, "zelda"));
    await engine.uninstall("zelda");
    mkdirSync(join(lib, "zelda", "saves"), { recursive: true });
    writeFileSync(join(lib, "zelda", "saves", "mm.sav"), "newer");
    await engine.install(61, lib);
    expect(read(lib, "zelda", "saves", "mm.sav")).toBe("newer");
    expect(read(lib, "zelda", "graphics.json")).toBe('{"res":4}');
    expect(read(lib, KEEP_DIR, "zelda", "saves", "mm.sav")).toBe("slot 1"); // the other copy stays set aside
  });
  test("deleteSaves wipes them, and what an earlier uninstall set aside", async () => {
    await engine.install(61, lib);
    writeSaves(join(lib, "zelda"));
    await engine.uninstall("zelda", { deleteSaves: true });
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
    await engine.install(61, lib);
    expect(existsSync(join(lib, "zelda", "saves"))).toBe(false);
    writeSaves(join(lib, "zelda"));
    await engine.uninstall("zelda");
    expect(existsSync(join(lib, KEEP_DIR, "zelda", "saves", "mm.sav"))).toBe(true);
    await engine.uninstall("zelda", { deleteSaves: true });                 // not installed any more
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
    expect(JSON.parse(read(data, "kept.json"))).toEqual([]);
  });
  test("a reinstall into another library folder still gets them back", async () => {
    await engine.install(61, lib);
    writeSaves(join(lib, "zelda"));
    await engine.uninstall("zelda");
    const lib2 = tmp("ahoy lib2-");
    await engine.install(61, lib2);
    expect(read(lib2, "zelda", "saves", "mm.sav")).toBe("slot 1");
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
  });
  test("a cancelled install puts the saves it took back where the uninstall left them", async () => {
    await engine.install(61, lib);
    writeSaves(join(lib, "zelda"));
    await engine.uninstall("zelda");
    const e2 = mk({ fetchImpl: slow });
    const p = e2.install(63, lib);
    await until(() => e2.isInstalling(63));
    e2.cancel(63);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(read(lib, KEEP_DIR, "zelda", "saves", "mm.sav")).toBe("slot 1");
    expect(existsSync(join(lib, "zelda", "saves", "mm.sav"))).toBe(false);
    await engine.install(63, lib);
    expect(read(lib, "zelda", "saves", "mm.sav")).toBe("slot 1");
  });
  test("uninstall refuses while the game runs", async () => {
    await engine.install(61, lib);
    writeSaves(join(lib, "zelda"));
    await engine.play("zelda");
    await expect(engine.uninstall("zelda")).rejects.toThrow(/running/);
    expect(read(lib, "zelda", "saves", "mm.sav")).toBe("slot 1");
    spawned[0].child.emit("exit", 0);
    await engine.uninstall("zelda");
    expect(existsSync(join(lib, "zelda"))).toBe(false);
  });
  test("a save that cannot be set aside stops the uninstall, and nothing is lost", async () => {
    await engine.install(61, lib);
    const dir = join(lib, "zelda");
    writeSaves(dir);
    mkdirSync(join(lib, KEEP_DIR, "zelda", "saves", "mm.sav", "in-the-way"), { recursive: true });
    await expect(engine.uninstall("zelda")).rejects.toThrow(/could not be set aside/);
    expect(read(dir, "saves", "mm.sav")).toBe("slot 1");
    expect(read(dir, "graphics.json")).toBe('{"res":4}');
    expect(existsSync(join(lib, KEEP_DIR, "zelda", "graphics.json"))).toBe(false);
    expect(await record("zelda")).toBeDefined();
  });
});

/** a record as installed.json holds it, for a folder a test made itself */
const recordFor = (slug: string, path: string, over: Partial<InstalledGame> = {}): InstalledGame => ({
  slug, gameId: 1, packageId: 1, name: slug, version: null, path, launch: { exe: "Game.exe", args: "", cwd: "" }, kind: "native", platform: null,
  sizeBytes: 1, installedAt: 1, serverUrl, ...over,
});

describe("one slug, two games", () => {
  // Alone in the Dark (2008) and its 2024 remake: one title, so one slug
  const aitd = () => {
    pkg(901, { "AloneInTheDark.exe": rnd(3000), "data/2008.pak": rnd(2000) }, { name: "Alone in the Dark", slug: "alone-in-the-dark", launch: { exe: "AloneInTheDark.exe", args: "", cwd: "" } }, 100);
    pkg(902, { "AloneInTheDark2024.exe": rnd(3100), "data/2024.pak": rnd(2100) }, { name: "Alone in the Dark", slug: "alone-in-the-dark", launch: { exe: "AloneInTheDark2024.exe", args: "", cwd: "" } }, 200);
  };
  test("another game with the same slug is refused before anything moves, and the one installed loses nothing", async () => {
    aitd();
    await engine.install(901, lib);
    hits.length = 0;
    await expect(engine.install(902, lib)).rejects.toThrow(/^another game is installed in the folder this one needs \(Alone in the Dark\) — uninstall it in Settings → On this PC first$/);
    expect(hits).toEqual([]);
    const dir = join(lib, "alone-in-the-dark");
    expect(readdirSync(dir).sort()).toEqual(["AloneInTheDark.exe", "data"]);
    expect(readdirSync(join(dir, "data"))).toEqual(["2008.pak"]);
    expect((await engine.installed()).map(g => `${g.gameId}:${g.packageId}`)).toEqual(["100:901"]);
    // a record whose folder is gone still holds the slug: uninstalling it is what frees it
    rmSync(dir, { recursive: true });
    await expect(engine.install(902, lib)).rejects.toThrow(/^another game is installed/);
    await engine.uninstall("alone-in-the-dark");
    expect((await engine.install(902, lib)).gameId).toBe(200);
  });
  test("a game recorded from another server, or without a gameId, is updated in place as before", async () => {
    pkg(905, { "Game.exe": rnd(700) }, { name: "Prey", slug: "prey" }, 500);
    const dir = join(lib, "prey");
    for (const [why, over] of [["another server", { gameId: 100, serverUrl: "http://elsewhere:8790" }], ["no gameId", { gameId: null }]] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(data, "installed.json"), JSON.stringify([recordFor("prey", dir, { name: "Prey", packageId: 904, ...over })]));
      expect((await engine.install(905, lib)).gameId, why).toBe(500);
    }
  });
  test("saves go back only into the game that set them aside, and two games of one slug never share a keep folder", async () => {
    const recomp = (id: number, name: string, exe: string, gameId: number) => pkg(id, { [exe]: rnd(1000 + id % 7), "portable.txt": "" }, {
      name, slug: "shared-slug", kind: "recomp", keep: ["saves/**", "*.cfg"], requires: { launcher: "0.10.0" }, launch: { exe, args: "", cwd: "", argv: [] },
    }, gameId);
    recomp(903, "Game A", "Recomp.exe", 300);
    recomp(904, "Game B", "Port.exe", 400);
    const dir = join(lib, "shared-slug");
    const play = (who: string) => { mkdirSync(join(dir, "saves"), { recursive: true }); writeFileSync(join(dir, "saves", "slot0.sav"), `${who}'s save`); writeFileSync(join(dir, "game.cfg"), who); };
    await engine.install(903, lib);
    play("A");
    await engine.uninstall("shared-slug");
    await engine.install(904, lib);                                          // game B: A's saves stay set aside
    expect(existsSync(join(dir, "saves", "slot0.sav"))).toBe(false);
    expect(existsSync(join(dir, "game.cfg"))).toBe(false);
    play("B");
    await engine.uninstall("shared-slug");                                   // B's go into a folder of their own
    expect(read(lib, KEEP_DIR, "shared-slug", "saves", "slot0.sav")).toBe("A's save");
    expect(read(lib, KEEP_DIR, ".shared-slug~400", "saves", "slot0.sav")).toBe("B's save");
    expect(read(lib, KEEP_DIR, ".shared-slug~400", "game.cfg")).toBe("B");
    await engine.install(903, lib);                                          // each game gets its own back
    expect(read(dir, "saves", "slot0.sav")).toBe("A's save");
    expect(read(dir, "game.cfg")).toBe("A");
    await engine.uninstall("shared-slug", { deleteSaves: true });            // A's saves go, B's stay
    expect(existsSync(join(lib, KEEP_DIR, "shared-slug"))).toBe(false);
    await engine.install(904, lib);
    expect(read(dir, "saves", "slot0.sav")).toBe("B's save");
    expect(read(dir, "game.cfg")).toBe("B");
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
    expect(JSON.parse(read(data, "kept.json"))).toEqual([]);
  });
  test("a package without a gameId takes back only what waits in the slug's own folder, and its uninstall never deletes a second game's saves", async () => {
    const port = (id: number, exe: string, gameId: number | null) => pkg(id, { [exe]: rnd(1100 + id % 7), "portable.txt": "" }, {
      name: "Shared", slug: "shared-two", kind: "port", keep: ["saves/**"], requires: { launcher: "0.10.0" }, launch: { exe, args: "", cwd: "", argv: [] },
    }, gameId);
    port(906, "A.exe", 600); port(907, "B.exe", 700); port(908, "C.exe", null);
    const dir = join(lib, "shared-two");
    const play = (file: string, text: string) => { mkdirSync(join(dir, "saves"), { recursive: true }); writeFileSync(join(dir, "saves", file), text); };
    await engine.install(906, lib); play("a.sav", "A"); await engine.uninstall("shared-two");
    await engine.install(907, lib); play("b.sav", "B"); await engine.uninstall("shared-two");   // B's wait in a folder of their own
    await engine.install(908, lib);                                          // no gameId: the slug's own folder, as before
    expect(readdirSync(join(dir, "saves"))).toEqual(["a.sav"]);
    expect(read(lib, KEEP_DIR, ".shared-two~700", "saves", "b.sav")).toBe("B");
    await engine.uninstall("shared-two", { deleteSaves: true });
    expect(read(lib, KEEP_DIR, ".shared-two~700", "saves", "b.sav")).toBe("B");
    await engine.install(907, lib);                                          // game B still gets its own back
    expect(read(dir, "saves", "b.sav")).toBe("B");
    expect(existsSync(join(lib, KEEP_DIR))).toBe(false);
    expect(JSON.parse(read(data, "kept.json"))).toEqual([]);
  });
  test("saves set aside before entries said whose they are go back into the game of the slug, as before", async () => {
    const keep = join(lib, KEEP_DIR, "zelda");
    mkdirSync(join(keep, "saves"), { recursive: true });
    writeFileSync(join(keep, "saves", "mm.sav"), "slot 1");
    writeFileSync(join(data, "kept.json"), JSON.stringify([{ slug: "zelda", dir: keep }]));
    await engine.install(61, lib);
    expect(read(lib, "zelda", "saves", "mm.sav")).toBe("slot 1");
    expect(JSON.parse(read(data, "kept.json"))).toEqual([]);
  });
});

describe("the lists on disk", () => {
  /** a game folder with many files, as a big install leaves it (deleting it takes a while) */
  const bigFolder = (slug: string, n: number) => {
    const dir = join(lib, slug);
    for (let d = 0; d * 100 < n; d++) {
      mkdirSync(join(dir, `d${d}`), { recursive: true });
      for (let i = 0; i < 100 && d * 100 + i < n; i++) writeFileSync(join(dir, `d${d}`, `f${i}.bin`), "x");
    }
    writeFileSync(join(dir, "Game.exe"), "exe");
    return dir;
  };
  test("two uninstalls at once both stay done, and an install that finishes during one keeps its record", async () => {
    const one = bigFolder("one", 4000), two = bigFolder("two", 5);
    writeFileSync(join(data, "installed.json"), JSON.stringify([recordFor("one", one), recordFor("two", two)]));
    await Promise.all([engine.uninstall("one"), engine.uninstall("two")]);   // the second is done long before the first
    expect([existsSync(one), existsSync(two)]).toEqual([false, false]);
    expect(await engine.installed()).toEqual([]);
    const big = bigFolder("big", 4000);
    writeFileSync(join(data, "installed.json"), JSON.stringify([recordFor("big", big)]));
    pkg(1001, { "Game.exe": rnd(500) }, { name: "Small", slug: "small" });
    await Promise.all([engine.uninstall("big"), engine.install(1001, lib)]);
    expect((await engine.installed()).map(g => g.slug)).toEqual(["small"]);
    expect(existsSync(join(lib, "small", "Game.exe"))).toBe(true);
  }, 30_000);
  test("installs that finish together keep every record", async () => {
    pkg(1003, { "Game.exe": rnd(500) }, { name: "Left", slug: "left" });
    pkg(1004, { "Game.exe": rnd(600) }, { name: "Right", slug: "right" });
    for (let round = 0; round < 5; round++) {
      writeFileSync(join(data, "installed.json"), "[]");
      await Promise.all([engine.install(1003, lib), engine.install(1004, lib)]);
      expect((await engine.installed()).map(g => g.slug).sort(), `round ${round}`).toEqual(["left", "right"]);
    }
  });
  test("saves of one list at the same moment never leave it broken: the last one asked for stays, whole, and no temporary file", async () => {
    const p = join(data, "list.json");
    for (let round = 0; round < 5; round++) {
      const texts = Array.from({ length: 24 }, (_, i) => JSON.stringify({ round, i, pad: "x".repeat((24 - i) * 2000) }));
      await Promise.all(texts.map(t => writeAtomic(p, t)));
      expect(texts.indexOf(read(p)), `round ${round}`).toBe(texts.length - 1);
    }
    expect(readdirSync(data).filter(f => f.endsWith(".tmp"))).toEqual([]);
  });

  /** two games installed; the function changes Left's start on the server in place (to bin/New.exe, and what `launch` says) */
  const twoGames = async (left: number, right: number) => {
    pkg(left, { "Game.exe": rnd(500), "bin/New.exe": rnd(400) }, { name: "Left", slug: "left" });
    pkg(right, { "Game.exe": rnd(600) }, { name: "Right", slug: "right" });
    await engine.install(left, lib);
    await engine.install(right, lib);
    return (launch: Partial<Manifest["launch"]>) => { const p = pkgs.get(left)!; p.manifest = { ...p.manifest, launch: { exe: "bin/New.exe", args: "", cwd: "", ...launch } }; };
  };
  /** Play Left with an engine: what it started (the game is ended again at once) */
  const playLeft = async (e: Engine) => { await e.play("left"); const s = spawned.at(-1)!; s.child.emit("exit", 0); return s; };
  /** another program opens a file without sharing it (no reading, no writing) for `ms`: resolves once it holds it */
  const holdFile = (file: string, ms: number) => new Promise<{ end: Promise<void> }>((ok, fail) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); [Console]::Out.WriteLine('held'); Start-Sleep -Milliseconds ${ms}; $f.Close()`],
      { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const end = new Promise<void>(r => p.on("exit", () => r()));
    p.stdout!.once("data", () => ok({ end }));
    p.on("error", fail);
  });

  test("an edit never writes back a list it could not read: one torn at that moment stays as it was, and no game is forgotten", async () => {
    const change = await twoGames(1005, 1006);
    const file = join(data, "installed.json"), whole = read(file), torn = whole.slice(0, 40);
    // while Play asks the server, the list is torn (a sync tool, another writer's crash)
    const tearing = (async (u: any, init?: RequestInit) => { if (String(u).endsWith("/launch")) writeFileSync(file, torn); return fetch(u, init); }) as typeof fetch;
    change({ rev: 1 });
    events = [];
    expect((await playLeft(mk({ fetchImpl: tearing }))).exe).toBe(join(lib, "left", "bin", "New.exe"));   // this Play starts the server's start
    expect(read(file)).toBe(torn);                                            // and the list is left as it was found
    expect(events.filter(e => e.type === "installed-changed")).toEqual([]);
    // whole again: the next Play saves the start, and both games are still there
    writeFileSync(file, whole);
    await playLeft(engine);
    const list = await engine.installed();
    expect(list.map(g => g.slug).sort()).toEqual(["left", "right"]);
    expect(list.find(g => g.slug === "left")!.launch).toMatchObject({ exe: "bin/New.exe", rev: 1 });
  });

  test.skipIf(process.platform !== "win32")("a list another program holds for a moment (a scanner, a backup) is read again; one held for longer is left as it is", async () => {
    const change = await twoGames(1007, 1008);
    const file = join(data, "installed.json");
    let holdMs = 250, held: Promise<void> = Promise.resolve();
    // while Play asks the server, another program opens the list without sharing it: reading it fails meanwhile
    const holding = (async (u: any, init?: RequestInit) => { if (String(u).endsWith("/launch")) held = (await holdFile(file, holdMs)).end; return fetch(u, init); }) as typeof fetch;
    const e = mk({ fetchImpl: holding });
    events = [];
    change({ rev: 1 });
    await playLeft(e);
    await held;
    let list = JSON.parse(read(file)) as InstalledGame[];
    expect(list.map(g => g.slug).sort()).toEqual(["left", "right"]);
    expect(list.find(g => g.slug === "left")!.launch).toMatchObject({ exe: "bin/New.exe", rev: 1 });
    // held longer than an edit waits: nothing is written (this Play still starts the server's start; the next one saves it)
    holdMs = 1500;
    change({ argv: ["--x"], rev: 2 });
    expect((await playLeft(e)).args).toEqual(["--x"]);
    await held;
    list = JSON.parse(read(file)) as InstalledGame[];
    expect(list.map(g => g.slug).sort()).toEqual(["left", "right"]);
    expect(list.find(g => g.slug === "left")!.launch.rev).toBe(1);
    expect(events.some(x => x.type === "installed-changed" && x.installed.length < 2)).toBe(false);
  }, 30_000);

  test.skipIf(process.platform !== "win32")("a list written in place (something keeps it from being renamed) leaves a whole copy beside it, which a torn list is read from", async () => {
    const change = await twoGames(1009, 1010);
    const file = join(data, "installed.json");
    // something keeps the list open (reading allowed, renaming not) for longer than a save waits: it is written in place
    change({ rev: 1 });
    const fd = openSync(file, "r");
    try { await playLeft(engine); } finally { closeSync(fd); }
    expect(read(file + ".bak")).toBe(read(file));
    expect((await engine.installed()).find(g => g.slug === "left")!.launch).toMatchObject({ exe: "bin/New.exe", rev: 1 });
    // a crash in the middle of that write would leave the list torn: it is read from the copy, by Play and by an edit
    writeFileSync(file, read(file).slice(0, 30));
    expect((await engine.installed()).map(g => g.slug).sort()).toEqual(["left", "right"]);
    change({ argv: ["--x"], rev: 2 });
    expect((await playLeft(engine)).args).toEqual(["--x"]);
    // that save was a whole one, made the usual way, so the copy is gone
    expect((JSON.parse(read(file)) as InstalledGame[]).map(g => [g.slug, g.launch.rev])).toEqual([["left", 2], ["right", undefined]]);
    expect(existsSync(file + ".bak")).toBe(false);
  });

  test("an install that cannot read the list of games at its end fails and says so, writing nothing over that list", async () => {
    pkg(1011, { "Game.exe": rnd(500) }, { name: "Late", slug: "late" });
    const file = join(data, "installed.json"), torn = '[{"slug":"other","gameId":1,"packageId":1,"name":"Other","pa';
    writeFileSync(file, torn);
    events = [];
    await expect(engine.install(1011, lib)).rejects.toThrow(/^this PC's list of games could not be read, so it was left as it is — try again/);
    expect(read(file)).toBe(torn);
    expect(events.filter(e => e.type === "install").at(-1)).toMatchObject({ phase: "failed" });
    expect(events.filter(e => e.type === "installed-changed")).toEqual([]);
  });

  test("an uninstall that cannot read where saves wait leaves that list as it is (never one entry in place of all), and still finishes", async () => {
    await engine.install(61, lib);
    const dir = join(lib, "zelda"), keepFile = join(data, "kept.json");
    writeSaves(dir);
    const torn = '[{"slug":"other","dir":"D:\\\\Games\\\\.ahoy-keep\\\\oth';
    writeFileSync(keepFile, torn);
    await engine.uninstall("zelda");
    expect(existsSync(dir)).toBe(false);
    expect(await engine.installed()).toEqual([]);
    expect(read(lib, KEEP_DIR, "zelda", "saves", "mm.sav")).toBe("slot 1");   // set aside where the next install looks first
    expect(read(keepFile)).toBe(torn);
  });
});

describe("while the game runs", () => {
  test("an update waits until the game is closed, and touches nothing meanwhile", async () => {
    pkg(1101, { "Game.exe": rnd(600), "Assets.pak": "assets v1", "old.dll": "old" }, { name: "Runner", slug: "runner", version: "1" }, 1100);
    pkg(1102, { "Game.exe": rnd(601), "Assets.pak": "assets v2!!", "new.dll": "new" }, { name: "Runner", slug: "runner", version: "2" }, 1100);
    await engine.install(1101, lib);
    await engine.play("runner");
    hits.length = 0;
    await expect(engine.install(1102, lib)).rejects.toThrow(/^the game is running — close it first$/);
    expect(hits).toEqual([]);
    expect(read(lib, "runner", "Assets.pak")).toBe("assets v1");
    expect(existsSync(join(lib, "runner", "old.dll"))).toBe(true);
    expect((await record("runner"))?.packageId).toBe(1101);
    spawned[0].child.emit("exit", 0);
    expect((await engine.install(1102, lib)).packageId).toBe(1102);
    expect(existsSync(join(lib, "runner", "old.dll"))).toBe(false);
  });
  test.skipIf(process.platform !== "win32")("a game started outside Ahoy (from its desktop shortcut, or before a restart) counts as running too", async () => {
    // a copy of ping as the game's program: a real process holds it, started without the engine knowing
    const ping = new Uint8Array(readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE")));
    pkg(1103, { "Game.exe": ping, "Assets.pak": "assets v1" }, { name: "Pinger", slug: "pinger", version: "1" }, 1110);
    pkg(1104, { "Game.exe": new Uint8Array([...ping, 0, 0, 0, 0]), "Assets.pak": "assets v2!!" }, { name: "Pinger", slug: "pinger", version: "2" }, 1110);
    await engine.install(1103, lib);
    const dir = join(lib, "pinger"), exe = join(dir, "Game.exe");
    const game = spawn(exe, ["-n", "30", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
    const exited = new Promise(r => game.once("exit", r));
    try {
      for (const t = Date.now(); !(await locked(exe)); await Bun.sleep(20)) if (Date.now() - t > 10_000) throw new Error("the game did not start");
      hits.length = 0;
      await expect(engine.install(1104, lib)).rejects.toThrow(/^the game is running — close it first$/);
      expect(hits).toEqual([]);
      expect(read(dir, "Assets.pak")).toBe("assets v1");
      expect((await record("pinger"))?.packageId).toBe(1103);
    } finally { game.kill(); }
    await exited;
    for (const t = Date.now(); await locked(exe); await Bun.sleep(20)) if (Date.now() - t > 10_000) throw new Error("the game did not let go");
    expect((await engine.install(1104, lib)).packageId).toBe(1104);
    expect(read(dir, "Assets.pak")).toBe("assets v2!!");
  }, 30_000);
  test("a program that is only read-only is not taken for a running one", async () => {
    const exe = rnd(700);
    pkg(1105, { "Game.exe": exe, "data.pak": "v1" }, { name: "Read Only", slug: "read-only", version: "1" }, 1120);
    pkg(1106, { "Game.exe": exe, "data.pak": "v2" }, { name: "Read Only", slug: "read-only", version: "2" }, 1120);
    await engine.install(1105, lib);
    const file = join(lib, "read-only", "Game.exe");
    chmodSync(file, 0o444);
    try {
      expect((await engine.install(1106, lib)).packageId).toBe(1106);
      expect(read(lib, "read-only", "data.pak")).toBe("v2");
    } finally { chmodSync(file, 0o666); }
  });
  test.skipIf(process.platform !== "win32")("a program no one may write to (a deny-write entry) is not taken for a running one either", async () => {
    const exe = rnd(700);
    pkg(1107, { "Game.exe": exe, "data.pak": "v1" }, { name: "Locked Down", slug: "locked-down", version: "1" }, 1130);
    pkg(1108, { "Game.exe": exe, "data.pak": "v2" }, { name: "Locked Down", slug: "locked-down", version: "2" }, 1130);
    await engine.install(1107, lib);
    const file = join(lib, "locked-down", "Game.exe"), who = process.env.USERNAME || userInfo().username;
    execFileSync("icacls", [file, "/deny", `${who}:(WD,AD)`], { stdio: "ignore", windowsHide: true });
    try {
      expect(await open(file, "r+").then(h => h.close().then(() => "free"), (e: any) => e?.code)).toBe("EPERM");
      expect((await engine.install(1108, lib)).packageId).toBe(1108);           // it ships the same program, which nothing writes
      expect(read(lib, "locked-down", "data.pak")).toBe("v2");
    } finally { execFileSync("icacls", [file, "/remove:d", who], { stdio: "ignore", windowsHide: true }); }
  });
  /** a copy of ping as a game's program, started outside the engine: a real process holds it until stop() */
  const pingBytes = () => new Uint8Array(readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE")));
  const runOutside = async (exe: string) => {
    const p = spawn(exe, ["-n", "30", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
    const exited = new Promise(r => { p.once("exit", r); p.once("error", r); });
    const stop = async () => {
      p.kill();
      await exited;
      for (const t = Date.now(); await locked(exe); await Bun.sleep(20)) if (Date.now() - t > 10_000) throw new Error("the game did not let go");
    };
    for (const t = Date.now(); !(await locked(exe)); await Bun.sleep(20)) if (Date.now() - t > 10_000) { await stop(); throw new Error("the game did not start"); }
    return { stop };
  };
  test.skipIf(process.platform !== "win32")("a game started by a launcher of its own that has exited counts as running while the game's program runs", async () => {
    // the record starts Game.exe, which starts the game's real program (Binaries/Game-Shipping.exe) and exits
    const real = pingBytes();
    pkg(1109, { "Assets.pak": "assets v1", "Binaries/Game-Shipping.exe": real, "Game.exe": rnd(900) }, { name: "Shipping", slug: "shipping", version: "1" }, 1140);
    pkg(1110, { "Assets.pak": "assets v2!!", "Binaries/Game-Shipping.exe": new Uint8Array([...real, 1, 2, 3]), "Game.exe": rnd(901) }, { name: "Shipping", slug: "shipping", version: "2" }, 1140);
    await engine.install(1109, lib);
    const dir = join(lib, "shipping");
    const game = await runOutside(join(dir, "Binaries", "Game-Shipping.exe"));
    try {
      hits.length = 0;
      await expect(engine.install(1110, lib)).rejects.toThrow(/^the game is running — close it first$/);
      expect(hits).toEqual([]);
      expect(read(dir, "Assets.pak")).toBe("assets v1");                       // nothing replaced under it
      expect((await record("shipping"))?.packageId).toBe(1109);
    } finally { await game.stop(); }
    expect((await engine.install(1110, lib)).packageId).toBe(1110);
    expect(read(dir, "Assets.pak")).toBe("assets v2!!");
  }, 30_000);
  test.skipIf(process.platform !== "win32")("an uninstall is refused while a game started outside Ahoy runs, and nothing of it goes", async () => {
    pkg(1111, { "Assets.pak": "assets", "Game.exe": pingBytes(), "data/levels.pak": "levels" }, { name: "Runner Three", slug: "runner-three", keep: ["saves/**"] }, 1150);
    await engine.install(1111, lib);
    const dir = join(lib, "runner-three");
    mkdirSync(join(dir, "saves"));
    writeFileSync(join(dir, "saves", "slot.sav"), "save");
    const game = await runOutside(join(dir, "Game.exe"));
    try {
      await expect(engine.uninstall("runner-three")).rejects.toThrow(/^the game is running — close it first$/);
      expect(readdirSync(dir).sort()).toEqual(["Assets.pak", "Game.exe", "data", "saves"]);
      expect(read(dir, "data", "levels.pak")).toBe("levels");
      expect(read(dir, "saves", "slot.sav")).toBe("save");
      expect(existsSync(join(lib, KEEP_DIR))).toBe(false);                     // nothing set aside either
      expect((await record("runner-three"))?.packageId).toBe(1111);
    } finally { await game.stop(); }
    await engine.uninstall("runner-three");
    expect(existsSync(dir)).toBe(false);
    expect(read(lib, KEEP_DIR, "runner-three", "saves", "slot.sav")).toBe("save");
  }, 30_000);
});

describe("desktop shortcuts", () => {
  test("the shortcut carries the arguments, is recorded, and uninstall removes only that one", async () => {
    writeFileSync(join(desk, "Other Game.lnk"), "the person's");
    const e = mk({ shortcuts: desktop() });
    const g = await e.install(31, lib);
    const dest = join(lib, "zelda64"), file = join(desk, "Zelda 64.lnk");
    expect(g.shortcut).toBe(file);
    expect(links).toEqual([{ file, target: join(dest, "Zelda64Recompiled.exe"), args: `--rom "${join(dest, "roms", "mm.us.z64")}" "${dest}" --flag "a b"`, cwd: dest, description: "Zelda 64 — Ahoy" }]);
    expect(JSON.parse(read(data, "installed.json")).find((r: InstalledGame) => r.slug === "zelda64").shortcut).toBe(file);
    await e.uninstall("zelda64");
    expect(existsSync(file)).toBe(false);
    expect(read(desk, "Other Game.lnk")).toBe("the person's");
  });
  test("a shortcut of the game's name that the launcher did not make is never overwritten or removed", async () => {
    writeFileSync(join(desk, "Zelda.lnk"), "mine");
    const e = mk({ shortcuts: desktop() });
    expect((await e.install(61, lib)).shortcut).toBeNull();
    expect(links).toEqual([]);
    await e.uninstall("zelda");
    expect(read(desk, "Zelda.lnk")).toBe("mine");
    if (process.platform === "win32") {                                     // Windows sees one file whatever the case
      rmSync(join(desk, "Zelda.lnk"));
      writeFileSync(join(desk, "ZELDA.lnk"), "mine too");
      expect((await e.install(61, lib)).shortcut).toBeNull();
      expect(read(desk, "ZELDA.lnk")).toBe("mine too");
    }
    // a game installed before 0.10.0 recorded no shortcut: one of its name that starts something elsewhere is the person's
    theirs(join(desk, "Legacy.lnk"));
    mkdirSync(join(lib, "legacy"));
    writeFileSync(join(data, "installed.json"), JSON.stringify([{ slug: "legacy", gameId: 1, packageId: 51, name: "Legacy", version: null, path: join(lib, "legacy"), launch: { exe: "Game.exe", args: "", cwd: "" }, kind: "native", platform: null, sizeBytes: 1, installedAt: 1, serverUrl }]));
    await e.uninstall("legacy");
    expect(existsSync(join(desk, "Legacy.lnk"))).toBe(true);
  });
  test("no shortcut for a game that needs its own environment, a console dump, or with the setting off", async () => {
    const e = mk({ shortcuts: desktop() });
    expect((await e.install(32, lib)).shortcut).toBeNull();
    expect((await e.install(9, lib)).shortcut).toBeNull();
    let on = false;
    const toggled = mk({ shortcuts: desktop(() => on) });
    expect((await toggled.install(7, lib)).shortcut).toBeNull();
    expect(links).toEqual([]);
    on = true;                                                               // the setting is read at every install
    expect((await toggled.install(7, lib)).shortcut).toBe(join(desk, "Hades.lnk"));
    expect(links.map(l => [l.target, l.args, l.cwd])).toEqual([[join(lib, "hades", "Hades.exe"), "", join(lib, "hades")]]);
  });
  test("an update rewrites the launcher's own shortcut where it is; one that cannot start the game is removed", async () => {
    const e = mk({ shortcuts: desktop() });
    const a = await e.install(61, lib);
    expect(a.shortcut).toBe(join(desk, "Zelda.lnk"));
    const b = await e.install(62, lib);
    expect(b.shortcut).toBe(a.shortcut);
    expect(links.map(l => l.file)).toEqual([a.shortcut!, a.shortcut!]);
    const c = await e.install(64, lib);                                      // now with env
    expect(c.shortcut).toBeNull();
    expect(existsSync(a.shortcut!)).toBe(false);
  });
  // Celeste in three versions, the way an update sees it
  const celeste = () => { for (const v of [1, 2, 3]) pkg(1200 + v, { "Celeste.exe": rnd(800 + v) }, { name: "Celeste", slug: "celeste", version: String(v), launch: { exe: "Celeste.exe", args: "", cwd: "" } }, 1200); };
  test("a shortcut the person put in place of the launcher's is never rewritten or removed", async () => {
    celeste();
    const e = mk({ shortcuts: desktop() });
    const lnk = join(desk, "Celeste.lnk");
    expect((await e.install(1201, lib)).shortcut).toBe(lnk);
    theirs(lnk, "D:\\itch\\Celeste\\Celeste.exe");                            // theirs now, to another copy of the game
    const persons = read(lnk);
    links.length = 0;
    expect((await e.install(1202, lib)).shortcut).toBeNull();                // an update
    expect(links).toEqual([]);
    expect(read(lnk)).toBe(persons);
    await e.uninstall("celeste");
    expect(read(lnk)).toBe(persons);
  });
  test("a shortcut the person deleted is not made again by updates; a new install makes one", async () => {
    celeste();
    const e = mk({ shortcuts: desktop() });
    const lnk = join(desk, "Celeste.lnk");
    expect((await e.install(1201, lib)).shortcut).toBe(lnk);
    rmSync(lnk);
    links.length = 0;
    await e.install(1202, lib);
    await e.install(1203, lib);                                              // the next update remembers too
    expect(links).toEqual([]);
    expect(existsSync(lnk)).toBe(false);
    await e.uninstall("celeste");
    expect((await e.install(1201, lib)).shortcut).toBe(lnk);
    expect(existsSync(lnk)).toBe(true);
  });
  test("a game installed before 0.10.0 takes over the shortcut of its name that starts it, and uninstall removes it", async () => {
    celeste();
    const e = mk({ shortcuts: desktop() });
    const dir = join(lib, "celeste"), lnk = join(desk, "Celeste.lnk");
    // what 0.9.0 left: a record without a shortcut, and a shortcut of the game's name that starts its program
    const legacy = () => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "Celeste.exe"), "old");
      writeFileSync(join(data, "installed.json"), JSON.stringify([recordFor("celeste", dir, { gameId: 1200, packageId: 1200, name: "Celeste", launch: { exe: "Celeste.exe", args: "", cwd: "" } })]));
      writeFileSync(lnk, JSON.stringify({ target: join(dir, "Celeste.exe"), args: "", cwd: dir }));
    };
    legacy();
    expect((await e.install(1201, lib)).shortcut).toBe(lnk);                 // an update takes it over and rewrites it
    expect(links.map(l => l.file)).toEqual([lnk]);
    await e.uninstall("celeste");
    expect(existsSync(lnk)).toBe(false);
    legacy();
    await e.uninstall("celeste");                                            // uninstalled with no update in between
    expect(existsSync(lnk)).toBe(false);
  });
  test("a shortcut the person makes to a game the launcher made none for is theirs: updates (the setting off, or turned on later) and uninstall leave it", async () => {
    celeste();
    let on = false;
    const e = mk({ shortcuts: desktop(() => on) });
    expect((await e.install(1201, lib)).shortcut).toBeNull();                 // the setting is off: none made, and the record says so
    expect(JSON.parse(read(data, "installed.json"))[0].shortcut).toBeNull();
    const dir = join(lib, "celeste"), lnk = join(desk, "Celeste.lnk");
    writeFileSync(lnk, JSON.stringify({ target: join(dir, "Celeste.exe"), args: "-console -fastboot", cwd: dir }));   // theirs, to the copy Ahoy installed
    const persons = read(lnk);
    await e.install(1202, lib);                                              // an update with the setting still off
    expect(read(lnk)).toBe(persons);
    on = true;
    links.length = 0;
    expect((await e.install(1203, lib)).shortcut).toBeNull();                // turned on: the name is theirs
    expect(links).toEqual([]);
    expect(read(lnk)).toBe(persons);
    await e.uninstall("celeste");
    expect(read(lnk)).toBe(persons);
  });
  test("shortcut names never hold what Windows refuses", () => {
    expect(shortcutName("Castlevania: Belmont's Curse")).toBe("Castlevania Belmont's Curse.lnk");
    expect(shortcutName("What?. ")).toBe("What.lnk");
    expect(shortcutName("***")).toBe("Game.lnk");
  });
});

describe("globs, versions, paths", () => {
  test("globs are anchored at the install folder; * stays in one folder, ** spans folders, {a,b} is either, case does not matter", () => {
    const m = globMatcher(["saves/**", "*.json", "inis/*.ini", "User/**/GC/*.raw", "*.{srm,sav}", "slot?.dat"]);
    for (const yes of ["saves/mm.sav", "saves/deep/er/x", "SAVES/MM.SAV", "graphics.json", "inis/PCSX2.ini", "User/GC/a.raw", "User/x/y/GC/a.raw", "game.srm", "game.sav", "slot1.dat", "saves\\win.sav"])
      expect(m(yes), yes).toBe(true);
    for (const no of ["other/saves/mm.sav", "data/graphics.json", "inis/sub/x.ini", "game.state", "slot10.dat", "save"])
      expect(m(no), no).toBe(false);
    expect(globMatcher(["../**", "/abs/*", "C:/x/*"])("abs/x")).toBe(false);  // a glob that would leave the folder matches nothing
    expect(globMatcher(undefined)("x")).toBe(false);
    expect(globMatcher(["a.b+c(1)"])("a.b+c(1)")).toBe(true);
    expect(globMatcher(["a.b"])("aXb")).toBe(false);
  });
  test("versions compare by major.minor.patch", () => {
    expect(versionAtLeast("0.10.0", "0.10.0")).toBe(true);
    expect(versionAtLeast("0.10.0", "0.9.9")).toBe(true);
    expect(versionAtLeast("0.10.0", "0.11.0")).toBe(false);
    expect(versionAtLeast("0.10.0", "0.10.1")).toBe(false);
    expect(versionAtLeast("1.0.0", "0.99.0")).toBe(true);
    expect(versionAtLeast("0.10.0-beta.1", "0.10.0")).toBe(true);
    expect(versionAtLeast("0.10", "0.10.0")).toBe(true);
    expect(versionAtLeast("0.10.0", "banana")).toBe(false);
    expect(versionAtLeast(undefined, "0.1.0")).toBe(false);
  });
  test("a path stays inside the folder, as Windows reads it", () => {
    for (const ok of ["Game.exe", "bin/x64/Game.exe", "roms/a&calc.cmd", "Data/Name With Spaces.pak", "...hidden.txt", "a.b/c"]) expect(pathProblem(ok), ok).toBeNull();
    for (const bad of ["", "../x", "a/../b", "a\\..\\b", "bin/.. /x", ". /x", "/x", "\\x", "C:/x", "x:y", "a//b", "a/", "x\u0000y", "a<b", "a?b", "a*b"]) expect(pathProblem(bad), bad).not.toBeNull();
    expect(pathProblem("saves/**", { glob: true })).toBeNull();
    expect(pathProblem("slot?.dat", { glob: true })).toBeNull();
    for (const ok of ["zelda", "zelda-64", "the-legend-of-zelda-majoras-mask"]) expect(safeSlug(ok), ok).toBe(true);
    for (const bad of ["", KEEP_DIR, "../x", "a/b", "a\\b", "x.", "x ", "c:", "a:b"]) expect(safeSlug(bad), bad).toBe(false);
  });
  test("arguments are quoted the way Windows programs read them back", () => {
    expect(quoteArg("plain")).toBe("plain");
    expect(quoteArg("C:\\no-space\\x")).toBe("C:\\no-space\\x");
    expect(quoteArg("")).toBe('""');
    expect(quoteArg("a b")).toBe('"a b"');
    expect(quoteArg("C:\\Games\\a b\\")).toBe('"C:\\Games\\a b\\\\"');
    expect(quoteArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(quoteArg('a\\"b c')).toBe('"a\\\\\\"b c"');
  });
});

/* ─────────── the start at Play: a start the server changed in place reaches the copies already installed ─────────── */
describe("the start at Play", () => {
  // a game whose package first started its settings window; the admin corrects the start in place: the same package, the
  // same files, a new stamp
  const FILES = {
    "Launcher.exe": rnd(3000), "bin/Game.exe": rnd(4000), "data/level.pak": rnd(2000), "run.cmd": "@echo off\r\nbin\\Game.exe %*\r\n",
    "tools/setup.ps1": "# setup", "saves/tool.exe": rnd(500),
  };
  const FIRST: Manifest["launch"] = { exe: "Launcher.exe", args: "", cwd: "", argv: [] };
  const FIXED: Manifest["launch"] = { exe: "bin/Game.exe", args: "", cwd: "{install}", argv: ["--data", "{install}/data/level.pak", "--fullscreen"], rev: 1731170000000 };
  const SLUG = "starter";
  const starter = (id: number) => pkg(id, FILES, { name: "Starter", slug: SLUG, kind: "native", requires: { launcher: "0.10.0" }, launch: { ...FIRST }, keep: ["saves/**"] }, 1300);
  /** the admin's change on the server: the same package, its start (and anything else said) changed in place */
  const edit = (id: number, launch: unknown, over: Partial<Manifest> = {}) => { const p = pkgs.get(id)!; p.manifest = { ...p.manifest, launch: launch as Manifest["launch"], ...over }; };
  const stop = () => spawned.at(-1)?.child.emit("exit", 0);
  /** Play with this engine: the program it started (the game is ended again at once) */
  const started = async (e: Engine) => { await e.play(SLUG); const exe = spawned.at(-1)!.exe; stop(); return exe; };
  const changed = () => events.filter(e => e.type === "installed-changed").length;
  /** what 0.9.0 left: a record without these fields */
  const asIfOld = async (drop: (keyof InstalledGame)[]) => {
    const r = { ...(await record(SLUG))! } as Partial<InstalledGame>;
    for (const k of drop) delete r[k];
    writeFileSync(join(data, "installed.json"), JSON.stringify([r]));
  };

  test("the next Play starts the corrected start; the record and the launcher's own shortcut follow; nothing is downloaded", async () => {
    engine = mk({ shortcuts: desktop() });
    starter(1300);
    const g = await engine.install(1300, lib);
    expect(g.launch).toEqual(FIRST);
    expect(g.shortcut).toBe(join(desk, "Starter.lnk"));
    const fetched = hits.length;
    edit(1300, FIXED);
    events = []; links.length = 0;
    await engine.play(SLUG);
    const s = spawned.at(-1)!;
    expect(s.exe).toBe(join(g.path, "bin", "Game.exe"));
    expect(s.args).toEqual(["--data", join(g.path, "data", "level.pak"), "--fullscreen"]);
    expect(s.opts.cwd).toBe(g.path);
    expect(asks).toEqual([1300]);
    expect(hits.length).toBe(fetched);                                       // no file fetched, nothing verified
    expect(await record(SLUG)).toMatchObject({ packageId: 1300, launch: FIXED, shortcut: g.shortcut });
    expect(JSON.parse(read(g.shortcut!))).toEqual({ target: join(g.path, "bin", "Game.exe"), args: `--data ${quoteArg(join(g.path, "data", "level.pak"))} --fullscreen`, cwd: g.path, description: "Starter — Ahoy" });
    expect(links.map(l => l.file)).toEqual([g.shortcut!]);
    expect(changed()).toBe(1);
    expect(events.findIndex(e => e.type === "installed-changed")).toBeLessThan(events.findIndex(e => e.type === "play"));
    stop();
    // asked again with nothing new: neither the record nor the shortcut is written again
    events = []; links.length = 0;
    expect(await started(engine)).toBe(join(g.path, "bin", "Game.exe"));
    expect(changed()).toBe(0);
    expect(links).toEqual([]);
    // the same start set again (a new stamp): the record keeps the stamp, the shortcut starts the same and is left alone
    edit(1300, { ...FIXED, rev: 1731170099999 });
    expect(await started(engine)).toBe(join(g.path, "bin", "Game.exe"));
    expect((await record(SLUG))!.launch.rev).toBe(1731170099999);
    expect(changed()).toBe(1);
    expect(links).toEqual([]);
  });

  test("the same server at a new address (http sent on to https): the copies recorded under the old one go with it, and Play keeps asking", async () => {
    // the new address stands in for the https one: another spelling that reaches the same fake server
    const now = serverUrl.replace("127.0.0.1", "moved.test");
    const there = (async (u: any, init?: RequestInit) => fetch(String(u).replace("//moved.test:", "//127.0.0.1:"), init)) as typeof fetch;
    starter(1340);
    const g = await engine.install(1340, lib);                               // recorded under the address of then
    edit(1340, FIXED);
    const moved = mk({ serverUrl: () => now, fetchImpl: there });
    expect(await started(moved)).toBe(join(g.path, "Launcher.exe"));         // not told: the copy is another address's, nothing is asked
    expect(asks).toEqual([]);
    events = [];
    await moved.serverMoved(`${serverUrl}/`, `${now}/`);
    expect((await record(SLUG))!.serverUrl).toBe(now);
    expect(changed()).toBe(1);                                               // the page hears of it
    expect(await started(moved)).toBe(join(g.path, "bin", "Game.exe"));
    expect(asks).toEqual([1340]);
  });
  test("…only what was recorded under the old address: another server's games and set-aside saves stay as they are", async () => {
    const other = "http://elsewhere:8790", now = "https://ahoy.example.com";
    const keep = (slug: string) => join(lib, KEEP_DIR, slug);
    writeFileSync(join(data, "installed.json"), JSON.stringify([recordFor("a", join(lib, "a")), recordFor("b", join(lib, "b"), { serverUrl: `${serverUrl}/` }), recordFor("c", join(lib, "c"), { serverUrl: other })]));
    writeFileSync(join(data, "kept.json"), JSON.stringify([{ slug: "a", dir: keep("a"), gameId: 1, serverUrl }, { slug: "z", dir: keep("z"), gameId: 9, serverUrl: other }, { slug: "y", dir: keep("y") }]));
    await engine.serverMoved(serverUrl, `${now}/`);
    expect((await engine.installed()).map(g => `${g.slug} ${g.serverUrl}`)).toEqual([`a ${now}`, `b ${now}`, `c ${other}`]);
    expect(JSON.parse(read(data, "kept.json"))).toEqual([{ slug: "a", dir: keep("a"), gameId: 1, serverUrl: now }, { slug: "z", dir: keep("z"), gameId: 9, serverUrl: other }, { slug: "y", dir: keep("y") }]);
    // nothing recorded under an address: nothing is written, nobody is told
    events = [];
    const before = [read(data, "installed.json"), read(data, "kept.json")];
    await engine.serverMoved("http://nowhere.example", "https://nowhere.example");
    await engine.serverMoved(now, `${now}/`);
    expect([read(data, "installed.json"), read(data, "kept.json")]).toEqual(before);
    expect(events).toEqual([]);
  });

  test("Play starts what it has when the server cannot say: offline, signed out, no answer in time, another address, the package gone", async () => {
    starter(1301);
    const g = await engine.install(1301, lib);
    const old = join(g.path, "Launcher.exe");
    edit(1301, FIXED);
    events = [];
    expect(await started(mk({ fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch }))).toBe(old);
    expect(await started(mk({ token: () => "signed-out" }))).toBe(old);             // the server says 401
    asks.length = 0;
    expect(await started(mk({ token: () => "" }))).toBe(old);                       // no session: nothing is asked
    expect(await started(mk({ serverUrl: () => serverUrl.replace("127.0.0.1", "localhost") }))).toBe(old);   // recorded from another address
    expect(asks).toEqual([]);
    // no answer in time: a request that hears the abort, and one that never settles at all
    const hears = ((_u: unknown, init?: RequestInit) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const deaf = (() => new Promise(() => {})) as unknown as typeof fetch;
    for (const f of [hears, deaf]) {
      const t = Date.now();
      expect(await started(mk({ launchAskMs: 80, fetchImpl: f }))).toBe(old);
      expect(Date.now() - t).toBeLessThan(2000);
    }
    // the package replaced or gone: that is an update, not a changed start
    const kept = pkgs.get(1301)!;
    pkgs.delete(1301);
    expect(await started(engine)).toBe(old);
    pkgs.set(1301, kept);
    expect((await record(SLUG))!.launch).toEqual(FIRST);
    expect(changed()).toBe(0);
    // once the server can say, the next Play takes it
    expect(await started(engine)).toBe(join(g.path, "bin", "Game.exe"));
  });

  test("Play never follows a start it must not: outside the folder, a script, not on disk, not installed with the package, the player's own, a newer launcher's", async () => {
    starter(1302);
    const g = await engine.install(1302, lib);
    const old = join(g.path, "Launcher.exe");
    writeFileSync(join(g.path, "bin", "Other.exe"), "a program the player put there");
    const L = (over: Record<string, unknown>) => ({ ...FIXED, ...over });
    const cases: [string, unknown, Partial<Manifest>?][] = [
      ["a program outside the folder", L({ exe: "../evil.exe" })],
      ["a program by its absolute path", L({ exe: "C:\\Windows\\System32\\notepad.exe" })],
      ["a script handed an argument the command shell would read (the folder's own space, through {install})", L({ exe: "run.cmd" })],
      ["a script handed another command", L({ exe: "run.cmd", argv: ["a&b"] })],
      ["a script by a name Windows would bend", L({ exe: "run.cmd.", argv: [] })],
      ...(process.platform === "win32" ? [["a PowerShell script", L({ exe: "tools/setup.ps1" })] as [string, unknown]] : []),
      ["a program not on disk", L({ exe: "bin/Missing.exe" })],
      ["a program this launcher did not install with the package", L({ exe: "bin/Other.exe" })],
      ["a program among the player's own files (keep)", L({ exe: "saves/tool.exe" })],
      ["a working folder outside", L({ cwd: "../elsewhere" })],
      ["a working folder that is not there", L({ cwd: "nowhere" })],
      ["arguments that are not a list", L({ argv: "--fullscreen" })],
      ["a variable with = in its name", L({ env: { "A=B": "x" } })],
      ["a field a newer launcher would read", L({ via: "powershell" })],
      ["a stamp that is not one", L({ rev: { at: 1 } })],
      ["no start at all", null],
      ["a start that needs a newer launcher", FIXED, { requires: { launcher: "9.0.0" } }],
      ["a requirement it cannot read", FIXED, { requires: { launcher: "soon" } }],
      ["a console dump", FIXED, { kind: "rom" }],
    ];
    events = [];
    for (const [why, launch, over] of cases) {
      edit(1302, launch, { requires: { launcher: "0.10.0" }, kind: "native", ...over });
      expect(await started(engine), why).toBe(old);
    }
    expect((await record(SLUG))!.launch).toEqual(FIRST);
    // the start it would not take is noted once, by its stamp, for the page to offer Update
    expect((await record(SLUG))!.skippedRev).toBe(FIXED.rev!);
    expect(changed()).toBe(1);
    expect(asks.length).toBe(cases.length);
  });

  test.skipIf(process.platform !== "win32")("a start changed to the game's own script is taken at the next Play, by a launcher that starts scripts and installed this one", async () => {
    engine = mk({ version: "0.11.0", scriptWatchMs: 10, scriptHandoverMs: 60 });
    starter(1310);
    const g = await engine.install(1310, lib);
    const scripted: Manifest["launch"] = { exe: "run.cmd", args: "--fullscreen", cwd: "", argv: ["--fullscreen"], rev: 1731170000009 };
    edit(1310, scripted, { requires: { launcher: "0.11.0" } });
    await engine.play(SLUG);
    const s = spawned.at(-1)!;
    expect(s.exe.toLowerCase()).toBe(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe").toLowerCase());
    expect(s.args).toEqual(["/d", "/v:off", "/s", "/c", '""%AHOY_START%" --fullscreen"']);
    expect(s.opts).toMatchObject({ cwd: g.path, windowsVerbatimArguments: true });
    expect((s.opts.env as Record<string, string>).AHOY_START).toBe(join(g.path, "run.cmd"));
    stop();
    for (const t = Date.now(); engine.isRunning(SLUG); await Bun.sleep(10)) if (Date.now() - t > 5000) throw new Error("it still counts as running");
    expect((await record(SLUG))!.launch).toEqual(scripted);
    // an older launcher keeps the start it has: the copy says it needs 0.11
    const older = mk();
    edit(1310, { ...scripted, argv: [], args: "", rev: 1731170000010 }, { requires: { launcher: "0.11.0" } });
    await older.play(SLUG);
    expect(spawned.at(-1)!.args.at(-1)).toBe('""%AHOY_START%" --fullscreen"');
    stop();
  });

  test("a game installed before 0.10.0 (no list of its files) takes a changed start whose program is on disk in its folder", async () => {
    starter(1303);
    const g = await engine.install(1303, lib);
    rmSync(join(data, "installed-files"), { recursive: true, force: true });
    await asIfOld(["keep", "seed", "shortcut"]);
    edit(1303, FIXED);
    expect(await started(engine)).toBe(join(g.path, "bin", "Game.exe"));
    expect((await record(SLUG))!.launch).toEqual(FIXED);
    // never a script (it is followed only when this launcher's own list says it installed it), nor a program that is not there
    for (const exe of ["run.cmd", "bin/Missing.exe"]) {
      edit(1303, { ...FIXED, exe, argv: [], rev: 2 });
      expect(await started(engine), exe).toBe(join(g.path, "bin", "Game.exe"));
    }
  });

  test("with the person's setting off, Play takes the start and the launcher's own shortcut goes, as an update takes it (a wrong start is worse than none)", async () => {
    let on = true;
    const e = mk({ shortcuts: desktop(() => on) });
    starter(1304);
    const g = await e.install(1304, lib);
    const lnk = join(desk, "Starter.lnk"), was = read(lnk);
    expect(g.shortcut).toBe(lnk);
    on = false;
    links.length = 0;
    // a new stamp on the same start: the shortcut still starts the game as Play does, so it stays
    edit(1304, { ...FIRST, rev: 3 });
    expect(await started(e)).toBe(join(g.path, "Launcher.exe"));
    expect(read(lnk)).toBe(was);
    // another program: the shortcut would start the old one, so it goes
    edit(1304, FIXED);
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect(existsSync(lnk)).toBe(false);
    expect(links).toEqual([]);
    expect((await e.installed())[0]).toMatchObject({ launch: FIXED, shortcut: null });
    // one the person makes there afterwards is theirs: never touched
    theirs(lnk);
    const persons = read(lnk);
    edit(1304, { ...FIXED, argv: ["--windowed"], rev: 4 });
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect(read(lnk)).toBe(persons);
  });

  test("Play never makes a shortcut: not for a game the launcher made none for, nor again for one the person deleted", async () => {
    starter(1305);
    const g = await engine.install(1305, lib);                              // no shortcuts in this engine: none recorded
    expect(g.shortcut).toBeNull();
    const e = mk({ shortcuts: desktop() });
    edit(1305, FIXED);
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect(readdirSync(desk)).toEqual([]);
    expect((await e.installed())[0].shortcut).toBeNull();
    // made at install, then deleted by the person: Play does not bring it back, and the record still knows it was made
    await e.uninstall(SLUG);
    const h = await e.install(1305, lib);
    expect(h.shortcut).toBe(join(desk, "Starter.lnk"));
    rmSync(h.shortcut!);
    links.length = 0;
    edit(1305, { ...FIXED, argv: ["--windowed"], rev: 5 });
    await started(e);
    expect(spawned.at(-1)!.args).toEqual(["--windowed"]);
    expect(readdirSync(desk)).toEqual([]);
    expect(links).toEqual([]);
    expect((await e.installed())[0]).toMatchObject({ launch: { argv: ["--windowed"] }, shortcut: h.shortcut });
  });

  test("a shortcut the launcher did not make is never touched: one the person put in its place, or one of the game's name that starts something else", async () => {
    const e = mk({ shortcuts: desktop() });
    starter(1306);
    const g = await e.install(1306, lib);
    const lnk = join(desk, "Starter.lnk");
    theirs(lnk);                                                             // theirs now, to a copy somewhere else
    const persons = read(lnk);
    links.length = 0;
    edit(1306, FIXED);
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect(read(lnk)).toBe(persons);
    expect(links).toEqual([]);
    // a game installed before 0.10.0 recorded no shortcut: one of its name that starts something elsewhere is the person's
    await asIfOld(["shortcut"]);
    edit(1306, { ...FIXED, argv: ["--windowed"], rev: 6 });
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect(spawned.at(-1)!.args).toEqual(["--windowed"]);
    expect(read(lnk)).toBe(persons);
    expect(links).toEqual([]);
    expect("shortcut" in (await e.installed())[0]).toBe(false);
  });

  test("a game installed before 0.10.0: the shortcut of its name that starts it (0.9.0 made it) follows, and is recorded from then on", async () => {
    starter(1307);
    const g = await engine.install(1307, lib);
    await asIfOld(["shortcut"]);
    const lnk = join(desk, "Starter.lnk");
    writeFileSync(lnk, JSON.stringify({ target: join(g.path, "Launcher.exe"), args: "", cwd: g.path }));
    const e = mk({ shortcuts: desktop() });
    edit(1307, FIXED);
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect(JSON.parse(read(lnk))).toMatchObject({ target: join(g.path, "bin", "Game.exe"), cwd: g.path });
    expect((await e.installed())[0].shortcut).toBe(lnk);
  });

  test("a start a shortcut cannot carry (its own environment) takes the launcher's shortcut away, as an update does", async () => {
    const e = mk({ shortcuts: desktop() });
    starter(1308);
    const g = await e.install(1308, lib);
    expect(existsSync(g.shortcut!)).toBe(true);
    edit(1308, { ...FIXED, env: { GAME_DATA: "{install}/data" } });
    await e.play(SLUG);
    const s = spawned.at(-1)!;
    expect(s.exe).toBe(join(g.path, "bin", "Game.exe"));
    expect((s.opts.env as Record<string, string>).GAME_DATA).toBe(join(g.path, "data"));
    stop();
    expect(existsSync(g.shortcut!)).toBe(false);
    expect((await e.installed())[0].shortcut).toBeNull();
  });

  test("two Plays at once start the game once; an install or an uninstall meanwhile is refused; a Play while it runs is told so", async () => {
    starter(1309);
    const g = await engine.install(1309, lib);
    edit(1309, FIXED);
    let release!: () => void, asked = 0;
    const gate = new Promise<void>(r => { release = r; });
    const held = (async (u: any, init?: RequestInit) => { if (String(u).endsWith("/launch")) { asked++; await gate; } return fetch(u, init); }) as typeof fetch;
    const e = mk({ fetchImpl: held });
    events = [];
    const a = e.play(SLUG), b = e.play(SLUG);
    await until(() => asked === 1);
    await expect(e.install(1309, lib)).rejects.toThrow(/^the game is running — close it first$/);
    await expect(e.uninstall(SLUG)).rejects.toThrow(/^the game is running — close it first$/);
    release();
    const [pa, pb] = await Promise.all([a, b]);
    expect(pa).toBe(pb);
    expect(spawned).toHaveLength(1);
    expect(spawned[0].exe).toBe(join(g.path, "bin", "Game.exe"));
    expect(asked).toBe(1);
    expect(changed()).toBe(1);
    expect(events.filter(x => x.type === "play" && x.running)).toHaveLength(1);
    await expect(e.play(SLUG)).rejects.toThrow(/^already running$/);
    stop();
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));         // closed: it starts again
    expect(spawned).toHaveLength(2);
  });

  test("two quick Plays start the game once even with no server to ask, and both hear its one start", async () => {
    starter(1310);
    const g = await engine.install(1310, lib);
    const e = mk({ token: () => "" });
    const pids = await Promise.all([e.play(SLUG), e.play(SLUG), e.play(SLUG)]);
    expect(spawned).toHaveLength(1);
    expect(new Set(pids).size).toBe(1);
    expect(spawned[0].exe).toBe(join(g.path, "Launcher.exe"));
    stop();
  });

  test("a changed start Play cannot take is noted on the copy, once, for the page to offer Update; nothing when nothing changed or no stamp says which; taking one clears it", async () => {
    starter(1311);
    const g = await engine.install(1311, lib);
    const old = join(g.path, "Launcher.exe");
    events = [];
    // the start as recorded, its program gone from disk: nothing changed on the server, so nothing to note (Play says why)
    rmSync(old);
    await expect(engine.play(SLUG)).rejects.toThrow(/^missing executable/);
    writeFileSync(old, "the program again");
    expect(changed()).toBe(0);
    const cases: [string, unknown, Partial<Manifest>, number | string][] = [
      ["a program not on disk", { ...FIXED, exe: "bin/Missing.exe", rev: 1731170000001 }, {}, 1731170000001],
      ["a start that needs a newer launcher", { ...FIXED, rev: "r-2" }, { requires: { launcher: "9.0.0" } }, "r-2"],
    ];
    for (const [why, launch, over, rev] of cases) {
      edit(1311, launch, { requires: { launcher: "0.10.0" }, ...over });
      expect(await started(engine), why).toBe(old);
      expect((await record(SLUG))!.skippedRev, why).toBe(rev);
    }
    expect(changed()).toBe(2);
    expect(await started(engine)).toBe(old);                                  // noted already: the list is not written again
    expect(changed()).toBe(2);
    // a start refused without a stamp gives the page nothing to compare: nothing new is noted
    edit(1311, { ...FIXED, exe: "bin/Missing.exe", rev: undefined }, { requires: { launcher: "0.10.0" } });
    expect(await started(engine)).toBe(old);
    expect(changed()).toBe(2);
    expect((await record(SLUG))!.launch).toEqual(FIRST);
    // once Play can take the server's start it does, and the note goes
    edit(1311, { ...FIXED, rev: 1731170000003 });
    expect(await started(engine)).toBe(join(g.path, "bin", "Game.exe"));
    const r = (await record(SLUG))!;
    expect(r.launch).toEqual({ ...FIXED, rev: 1731170000003 });
    expect("skippedRev" in r).toBe(false);
  });

  test("a shortcut that cannot be written at that Play is tried again at the next: the record takes the start only together with it", async () => {
    let fail: false | "refuses" | "throws" = false;
    const d = desktop();
    const e = mk({ shortcuts: { ...d, write: (f, l) => { if (fail === "throws") throw new Error("the desktop is locked"); return fail ? false : d.write(f, l); } } });
    starter(1323);
    const g = await e.install(1323, lib);
    const lnk = g.shortcut!;
    expect(lnk).toBe(join(desk, "Starter.lnk"));
    for (const how of ["refuses", "throws"] as const) {
      fail = how;
      edit(1323, { ...FIXED, rev: how === "refuses" ? 11 : 12 });
      expect(await started(e), how).toBe(join(g.path, "bin", "Game.exe"));    // this Play starts the server's start
      expect((await e.installed())[0].launch, how).toEqual(FIRST);           // the record waits for its shortcut
      expect(JSON.parse(read(lnk)).target, how).toBe(join(g.path, "Launcher.exe"));
    }
    fail = false;
    expect(await started(e)).toBe(join(g.path, "bin", "Game.exe"));
    expect((await e.installed())[0]).toMatchObject({ launch: { ...FIXED, rev: 12 }, shortcut: lnk });
    expect(JSON.parse(read(lnk)).target).toBe(join(g.path, "bin", "Game.exe"));
  });

  test("Play takes a program only from a list of installed files it can trust: not one torn, another package's, or gone for a game that kept one", async () => {
    starter(1324);
    const g = await engine.install(1324, lib);
    const fl = join(data, "installed-files", `${SLUG}.json`), good = read(fl);
    edit(1324, FIXED);                                                        // bin/Game.exe is on the list
    const cases: [string, () => void][] = [
      ["a torn list", () => writeFileSync(fl, good.slice(0, 20))],
      ["another package's list (a save that failed)", () => writeFileSync(fl, JSON.stringify({ ...JSON.parse(good), packageId: 1 }))],
      ["no list, for a game installed by 0.10.0 or later", () => rmSync(fl)],
    ];
    for (const [why, mess] of cases) {
      mess();
      expect(await started(engine), why).toBe(join(g.path, "Launcher.exe"));
    }
    writeFileSync(fl, good);
    expect(await started(engine)).toBe(join(g.path, "bin", "Game.exe"));
  });

  test("Play is refused while the game is being updated or removed", async () => {
    starter(1325);
    await engine.install(1325, lib);
    pkg(1326, { ...FILES, "data/level.pak": rnd(400_000) }, { name: "Starter", slug: SLUG, kind: "native", requires: { launcher: "0.10.0" }, launch: { ...FIRST }, keep: ["saves/**"] }, 1300);
    const e = mk({ fetchImpl: slow });
    const upd = e.install(1326, lib);
    await until(() => e.isInstalling(1326));
    await expect(e.play(SLUG)).rejects.toThrow(/^it is being installed or removed — wait for that$/);
    await upd;
    const un = e.uninstall(SLUG);
    await expect(e.play(SLUG)).rejects.toThrow(/^it is being installed or removed — wait for that$/);
    await un;
    expect(spawned).toEqual([]);
  });

  test("Play never takes a working folder that leads out of the game's folder through a link", async () => {
    starter(1327);
    const g = await engine.install(1327, lib);
    symlinkSync(tmp("ahoy-outside-"), join(g.path, "data", "jn"), "junction");
    edit(1327, { ...FIXED, cwd: "data/jn" });
    expect(await started(engine)).toBe(join(g.path, "Launcher.exe"));
    mkdirSync(join(g.path, "data", "here"));
    edit(1327, { ...FIXED, cwd: "data/here", rev: 13 });
    await engine.play(SLUG);
    expect(spawned.at(-1)!.opts.cwd).toBe(join(g.path, "data", "here"));
    stop();
  });

  test("Play takes no start from an answer too big to be one: over 64 KB, or a stamp, arguments or a command line past their limits", async () => {
    starter(1328);
    const g = await engine.install(1328, lib);
    const old = join(g.path, "Launcher.exe");
    /** an engine whose server answers /launch with this */
    const answering = (body: () => Response) => mk({ fetchImpl: (async (u: any, init?: RequestInit) => (String(u).endsWith("/launch") ? body() : fetch(u, init))) as typeof fetch });
    const json = (launch: unknown) => JSON.stringify({ launch, rev: null, requires: { launcher: "0.10.0" }, kind: "native" });
    const big = json({ ...FIXED, args: "x".repeat(70_000) });
    const cases: [string, () => Response][] = [
      ["a body that says it is over 64 KB", () => new Response(big, { headers: { "content-type": "application/json", "content-length": String(big.length) } })],
      ["a body over 64 KB that does not say so", () => new Response(new ReadableStream({ start(c) { for (let i = 0; i < big.length; i += 4096) c.enqueue(enc(big.slice(i, i + 4096))); c.close(); } }))],
      ["a stamp of over 64 characters", () => new Response(json({ ...FIXED, rev: "r".repeat(65) }))],
      ["arguments over 32 KB", () => new Response(json({ ...FIXED, args: "a ".repeat(17_000) }))],
      ["a command line longer than Windows takes", () => new Response(json({ ...FIXED, argv: Array.from({ length: 40 }, () => "z".repeat(900)) }))],
    ];
    for (const [why, body] of cases) expect(await started(answering(body)), why).toBe(old);
    expect((await record(SLUG))!.launch).toEqual(FIRST);
    // the same within the limits: taken
    expect(await started(answering(() => new Response(json({ ...FIXED, argv: Array.from({ length: 30 }, () => "z".repeat(900)) }))))).toBe(join(g.path, "bin", "Game.exe"));
  });
});

describe("Cancel reaches every phase, and a prerequisite cannot hang the install", () => {
  test("Cancel while files are checked ends the install: cancelled, nothing recorded, the game free again", async () => {
    let e2!: Engine;
    let asked = false;
    e2 = mk({ onEvent: e => { events.push(e); if (e.type === "install" && e.phase === "verifying" && !asked) { asked = true; e2.cancel(7); } } });
    await expect(e2.install(7, lib)).rejects.toThrow(/cancelled/);
    expect(asked).toBe(true);
    expect(events.filter(e => e.type === "install").at(-1)).toMatchObject({ phase: "cancelled" });
    expect(installers).toEqual([]);
    expect(await e2.installed()).toHaveLength(0);
    await e2.install(7, lib);                                              // not left "already installing"
    expect(await e2.installed()).toHaveLength(1);
  });
  test("Cancel while a prerequisite runs stops that installer and ends the install", async () => {
    let stopped = false, started = false;
    const e2 = mk({ runInstaller: (_exe, _args, _cwd, signal) => new Promise<number>(() => { started = true; signal?.addEventListener("abort", () => { stopped = true; }); }) });
    const p = e2.install(7, lib);
    await until(() => started);
    expect(e2.isInstalling(7)).toBe(false);                                // no download under way: the old Cancel had nothing to act on
    e2.cancel(7);
    await expect(p).rejects.toThrow(/cancelled/);
    expect(stopped).toBe(true);
    expect(events.filter(e => e.type === "install").at(-1)).toMatchObject({ phase: "cancelled" });
    expect(await e2.installed()).toHaveLength(0);
    await expect(e2.uninstall("hades")).resolves.toBeUndefined();          // the game is not held busy
  });
  test("a prerequisite that never ends is stopped after its time and the install goes on", async () => {
    let stopped = false;
    const e2 = mk({ installerMaxMs: 40, runInstaller: (_exe, _args, _cwd, signal) => new Promise<number>(() => { signal?.addEventListener("abort", () => { stopped = true; }); }) });
    const g = await e2.install(7, lib);
    expect(g.slug).toBe("hades");
    expect(stopped).toBe(true);
    expect(events.some(e => e.type === "install" && e.phase === "prerequisites" && /vcredist: took too long, stopped \(continuing\)/.test(e.message ?? ""))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "install", phase: "done" });
  });
  test.skipIf(process.platform !== "win32")("the real installer runner ends a program that waits forever", async () => {
    // a package whose prerequisite is a program that never exits by itself (the system's own ping, copied in)
    const ping = readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "PING.EXE"));
    pkg(1401, { "Game.exe": rnd(2000), "redist/wait.exe": new Uint8Array(ping) as Bytes }, { name: "Waits", slug: "waits", prerequisites: [{ kind: "vcredist", path: "redist/wait.exe", args: "-t 127.0.0.1" }] }, 1401);
    const e2 = new Engine({ dataDir: data, serverUrl: () => serverUrl, token: () => KEY, version: "0.10.0", onEvent: e => events.push(e), spawnGame: fakeSpawn, segments: 2, installerMaxMs: 400 });
    const t = Date.now();
    await e2.install(1401, lib);
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(events.some(e => e.type === "install" && /took too long/.test(e.message ?? ""))).toBe(true);
    await until(() => { try { rmSync(join(lib, "waits", "redist", "wait.exe")); return true; } catch { return false; } });   // deletable: it is not running any more
  });
  test.skipIf(process.platform !== "win32")("…and the program that one started with it (an installer that unpacks itself and waits for the real setup)", async () => {
    // the wrapper: the system's command prompt, copied in, starting the "real setup" (ping, copied in beside it) and waiting for it
    const sys = (name: string) => new Uint8Array(readFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", name))) as Bytes;
    pkg(1402, { "Game.exe": rnd(2000), "redist/setup.exe": sys("cmd.exe"), "redist/inner.exe": sys("PING.EXE") },
      { name: "Wraps", slug: "wraps", prerequisites: [{ kind: "vcredist", path: "redist/setup.exe", args: "/c .\\inner.exe -n 47 127.0.0.1" }] }, 1402);
    const e2 = new Engine({ dataDir: data, serverUrl: () => serverUrl, token: () => KEY, version: "0.10.0", onEvent: e => events.push(e), spawnGame: fakeSpawn, segments: 2, installerMaxMs: 1500 });
    await e2.install(1402, lib);
    expect(events.some(e => e.type === "install" && /took too long/.test(e.message ?? ""))).toBe(true);
    // deletable, both: neither is running any more (left alone, the inner one would go on for most of a minute)
    for (const exe of ["inner.exe", "setup.exe"]) await until(() => { try { rmSync(join(lib, "wraps", "redist", exe)); return true; } catch { return false; } }, 8_000);
  }, 30_000);
});
