/**
 * A game that starts through its own command script (.bat, .cmd), from 0.11.0:
 *  - what a script may be handed: plain words, or it is no start (not installed, never started)
 *  - how the command shell gets it: the script's path in a variable, so nothing in the path is ever read as a command —
 *    held against the real cmd.exe, with a folder and a file name made of everything the shell reads as its own
 *  - a script that hands the game on and ends: the game counts as running while one of its programs does
 * Windows only, as a script start is.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { Engine, SCRIPT_ARG, SCRIPT_VAR, checkLaunch, checkManifest, launchCommand, shortcutFor, type EngineEvent, type InstalledGame, type Manifest, type SpawnGame } from "../src/engine";

const win = process.platform === "win32";
const made: string[] = [];
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });
const SYSTEM = process.env.SystemRoot ?? "C:\\Windows";
const base = { SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32" };
const L = (over: Partial<Manifest["launch"]> = {}): Manifest["launch"] => ({ exe: "start.bat", args: "", cwd: "", ...over });

describe("what a start script may be handed", () => {
  test("plain words only: letters, digits and . _ - + = , : / \\ @", () => {
    for (const ok of ["hdeyguxs3zaumvlgvybm2vyc", "--mode=sp", "-w", "1920x1080", "C:\\Games\\x\\y.cfg", "a/b", "user@host", "k=v,w=x", "+set", "v1.2.3_final"]) expect(SCRIPT_ARG.test(ok), ok).toBe(true);
    for (const bad of ["", "a b", 'a"b', "a'b", "%PATH%", "100%", "a&b", "a|b", "(x)", "^x", "!x!", "a;b", "x>y", "x<y", "`x`", "$x", "a\tb", "a\nb", "é", "{install}", "*", "?", "~", "#"]) expect(SCRIPT_ARG.test(bad), bad).toBe(false);
  });

  test.skipIf(!win)("a start with any other argument is no start: not for Play, not for a shortcut, not to install", () => {
    const at = { path: "C:\\Games\\x" }, o = { platform: "win32", baseEnv: base };
    for (const bad of ["a b", 'a"b', "%PATH%", "a&b", "(x)", "a|b", "^x", "!x!", "é", "{install}/a b/c"]) {
      expect(() => launchCommand({ ...at, launch: L({ argv: [bad] }) }, o), bad).toThrow(/more than a plain word/);
      expect(() => checkLaunch(L({ argv: [bad] })), bad).toThrow(/not safe to install: its start script is handed an argument that is more than a plain word/);
    }
    // the old space-separated form is read the same way
    expect(() => launchCommand({ ...at, launch: L({ args: "ok a&b" }) }, o)).toThrow(/more than a plain word/);
    expect(() => checkLaunch(L({ args: "ok a&b" }))).toThrow(/start script/);
    // {install} is a path, and a path is handed over only when it is plain words itself
    expect(launchCommand({ ...at, launch: L({ argv: ["{install}/cfg/a.cfg"] }) }, o).own).toEqual(["C:\\Games\\x\\cfg\\a.cfg"]);
    expect(() => launchCommand({ path: "C:\\My Games\\x", launch: L({ argv: ["{install}/cfg/a.cfg"] }) }, o)).toThrow(/more than a plain word/);
    // a whole manifest: the same refusal, before anything is downloaded
    const m = { name: "X", slug: "x", version: null, totalSize: 1, files: [{ path: "start.bat", size: 1, sha256: "0".repeat(64) }], launch: L({ argv: ["a&b"] }) } as unknown as Manifest;
    expect(() => checkManifest(m, "0.11.0")).toThrow(/not safe to install/);
    expect(() => checkManifest({ ...m, launch: L({ argv: ["ok"] }) } as Manifest, "0.11.0")).not.toThrow();
  });

  test.skipIf(!win)("a bent name, another system, the launcher's own variable: no start either", () => {
    const at = { path: "C:\\Games\\x" }, o = { platform: "win32", baseEnv: base };
    for (const exe of ["go.bat.", "go.cmd  ", "go.BAT. ."]) expect(() => launchCommand({ ...at, launch: L({ exe }) }, o), exe).toThrow(/not a plain \.bat or \.cmd/);
    expect(() => launchCommand({ ...at, launch: L() }, { platform: "linux" })).toThrow(/only Windows runs/);
    expect(() => launchCommand({ ...at, launch: L({ env: { ahoy_start: "C:\\evil.bat" } }) }, o)).toThrow(/AHOY_START, which is the launcher's own/);
    // a script outside the game's folder is no more a start than a program there
    expect(() => launchCommand({ ...at, launch: L({ exe: "../other/start.bat" }) }, o)).toThrow(/not inside its folder/);
  });
});

describe("how the command shell gets a script", () => {
  test.skipIf(!win)("its path in a variable, its arguments as written, the game's variables with it; a program starts as it always did", () => {
    const install = "C:\\Games\\a & b\\100% (x)";
    const c = launchCommand({ path: install, launch: L({ exe: "!start sp26.BAT", argv: ["hdeyguxs3zaumvlgvybm2vyc", "--mode=sp"], env: { GAME_MODE: "sp", path: "C:\\x" } }) }, { platform: "win32", baseEnv: base });
    const script = `${install}\\!start sp26.BAT`;
    expect(c).toEqual({
      exe: "C:\\Windows\\System32\\cmd.exe", args: ["/d", "/v:off", "/s", "/c", '""%AHOY_START%" hdeyguxs3zaumvlgvybm2vyc --mode=sp"'], cwd: install,
      // the game's variables over the launcher's (a name in another case is the same variable), and the script's path
      env: { SystemRoot: "C:\\Windows", GAME_MODE: "sp", path: "C:\\x", [SCRIPT_VAR]: script },
      file: script, own: ["hdeyguxs3zaumvlgvybm2vyc", "--mode=sp"], script: true,
    });
    // no arguments: the path alone; a folder of its own to start in when the start names one
    const d = launchCommand({ path: install, launch: L({ exe: "tools/run.cmd", cwd: "{install}" }) }, { platform: "win32", baseEnv: base });
    expect([d.args.at(-1), d.cwd, d.file]).toEqual(['""%AHOY_START%""', install, `${install}\\tools\\run.cmd`]);
    expect(launchCommand({ path: install, launch: L({ exe: "tools/run.cmd" }) }, { platform: "win32", baseEnv: base }).cwd).toBe(`${install}\\tools`);
    // a program: itself, its arguments quoted by Windows' own rules later, no variable of the launcher's
    const p = launchCommand({ path: install, launch: L({ exe: "bin/Game.exe", argv: ["a b", "--x"] }) }, { platform: "win32", baseEnv: base });
    expect(p).toEqual({ exe: `${install}\\bin\\Game.exe`, args: ["a b", "--x"], cwd: `${install}\\bin`, env: null, file: `${install}\\bin\\Game.exe`, own: ["a b", "--x"], script: false });
  });

  test.skipIf(!win)("a desktop shortcut starts the script itself, with its arguments; none for a start Play would refuse", () => {
    const g = (launch: Manifest["launch"], path = "C:\\Games\\x") => ({ slug: "x", gameId: 1, packageId: 1, name: "X", version: null, path, launch, kind: "native", platform: null, sizeBytes: 1, installedAt: 0, serverUrl: "" }) as InstalledGame;
    expect(shortcutFor(g(L({ exe: "!start.bat", argv: ["sp26", "--mode=1"] })))).toEqual({ target: "C:\\Games\\x\\!start.bat", args: "sp26 --mode=1", cwd: "C:\\Games\\x" });
    expect(shortcutFor(g(L({ argv: ["a&b"] })))).toBeNull();
    expect(shortcutFor(g(L({ env: { A: "b" } })))).toBeNull();                 // a shortcut carries no variables
  });

  test.skipIf(!win)("the real command shell: a path made of everything it reads as its own is one path, the script gets its own arguments, nothing else runs", async () => {
    // & starts a command, ( ) group, ^ escapes, % and ! expand, ' ; , = split words for some commands
    const root = join(tmp("ahoy-cmd-"), "a & b (c) ^d %TEMP% !e! 'f' ;g,h=i&mkdir pwned&");
    mkdirSync(root, { recursive: true });
    const name = "!start & go %OS% (1) ^x.bat";
    writeFileSync(join(root, name), [
      "@echo off",
      '>"%~dp0out.txt" echo dir="%~dp0"',
      '>>"%~dp0out.txt" echo name="%~nx0"',
      '>>"%~dp0out.txt" echo args=%*',
      '>>"%~dp0out.txt" echo var=%GAME_VAR%',
      '>>"%~dp0out.txt" echo cd="%CD%"',
      "exit /b 7", "",
    ].join("\r\n"));
    const c = launchCommand({ path: root, launch: L({ exe: name, argv: ["one", "--two=2", "C:\\three\\3"], env: { GAME_VAR: "set-by-the-game" } }) });
    const code = await new Promise<number | null>((res, rej) => {
      const p = spawn(c.exe, c.args, { cwd: c.cwd, env: c.env!, windowsHide: true, stdio: "ignore", windowsVerbatimArguments: true });
      p.once("exit", res); p.once("error", rej);
    });
    expect(code).toBe(7);
    expect(readFileSync(join(root, "out.txt"), "utf8").split(/\r?\n/).filter(Boolean)).toEqual([
      `dir="${root}\\"`, `name="${name}"`, "args=one --two=2 C:\\three\\3", "var=set-by-the-game", `cd="${root}"`,
    ]);
    // nothing the path holds ran as a command: no folder of that name here, in the game's folder or beside it
    for (const at of [process.cwd(), root, join(root, "..")]) expect(existsSync(join(at, "pwned")), at).toBe(false);
    expect(c.exe.toLowerCase()).toBe(join(SYSTEM, "System32", "cmd.exe").toLowerCase());
  });
});

describe("a script that hands the game on and ends", () => {
  /** is a file held by a running program (Windows refuses to open a program it runs for writing) */
  const locked = async (file: string) => { try { await (await open(file, "r+")).close(); return false; } catch (e: any) { return e?.code === "EBUSY"; } };
  /** a copy of ping as the game's program: a real process holds it until stop() */
  const runGame = async (exe: string) => {
    const p = spawn(exe, ["-n", "60", "127.0.0.1"], { windowsHide: true, stdio: "ignore" });
    const exited = new Promise(r => { p.once("exit", r); p.once("error", r); });
    const stop = async () => { p.kill(); await exited; for (const t = Date.now(); await locked(exe); await Bun.sleep(20)) if (Date.now() - t > 10_000) throw new Error("the game did not let go"); };
    for (const t = Date.now(); !(await locked(exe)); await Bun.sleep(20)) if (Date.now() - t > 10_000) { await stop(); throw new Error("the game did not start"); }
    return { stop };
  };
  /** an engine with one game on this PC that starts through its script; what Play handed to spawn */
  function scripted(over: { scriptWatchMs?: number; scriptHandoverMs?: number } = {}) {
    const data = tmp("ahoy-script-data-"), lib = tmp("ahoy-script-lib-");
    const path = join(lib, "handed-on");
    mkdirSync(join(path, "bin"), { recursive: true });
    writeFileSync(join(path, "start.bat"), "@echo off\r\n");
    writeFileSync(join(path, "bin", "Game.exe"), new Uint8Array(readFileSync(join(SYSTEM, "System32", "PING.EXE"))));
    const g: InstalledGame = { slug: "handed-on", gameId: 5, packageId: 9, name: "Handed On", version: null, path, launch: L(), kind: "native", platform: null, sizeBytes: 1, installedAt: 1, serverUrl: "" };
    writeFileSync(join(data, "installed.json"), JSON.stringify([g]));
    const events: EngineEvent[] = [];
    const spawned: { exe: string; args: string[]; opts: SpawnOptions; child: EventEmitter }[] = [];
    const spawnGame: SpawnGame = (exe, args, opts) => { const child = Object.assign(new EventEmitter(), { pid: 4321, unref() {} }); spawned.push({ exe, args, opts, child }); return child as unknown as ChildProcess; };
    const engine = new Engine({ dataDir: data, serverUrl: () => "", token: () => "", version: "0.11.0", onEvent: e => events.push(e), spawnGame, ...over });
    const plays = () => events.filter((e): e is Extract<EngineEvent, { type: "play" }> => e.type === "play").map(e => e.running);
    return { engine, path, spawned, plays };
  }

  test.skipIf(!win)("the game counts as running while one of its programs does, and Play is not offered twice", async () => {
    const { engine, path, spawned, plays } = scripted({ scriptWatchMs: 30, scriptHandoverMs: 5000 });
    await engine.play("handed-on");
    expect(spawned).toHaveLength(1);
    expect(spawned[0].opts).toMatchObject({ windowsVerbatimArguments: true, cwd: path });
    // the script started the game's program and ended (as one does that asked for administrator rights and started itself again)
    const game = await runGame(join(path, "bin", "Game.exe"));
    try {
      spawned[0].child.emit("exit", 0);
      await Bun.sleep(250);
      expect(engine.isRunning("handed-on")).toBe(true);
      expect(plays()).toEqual([true]);
      await expect(engine.play("handed-on")).rejects.toThrow(/already running/);
      await expect(engine.uninstall("handed-on")).rejects.toThrow(/running/);
    } finally { await game.stop(); }
    for (const t = Date.now(); engine.isRunning("handed-on"); await Bun.sleep(20)) if (Date.now() - t > 5000) throw new Error("it still counts as running");
    expect(plays()).toEqual([true, false]);
  });

  test.skipIf(!win)("a script that ends with nothing of the game running: after the time the game had to appear, it is not running", async () => {
    const { engine, spawned, plays } = scripted({ scriptWatchMs: 20, scriptHandoverMs: 200 });
    await engine.play("handed-on");
    spawned[0].child.emit("exit", 1);
    expect(engine.isRunning("handed-on")).toBe(true);                          // the player may still be answering Windows' question
    for (const t = Date.now(); engine.isRunning("handed-on"); await Bun.sleep(20)) if (Date.now() - t > 5000) throw new Error("it still counts as running");
    expect(plays()).toEqual([true, false]);
    // and it can be played again
    await engine.play("handed-on");
    expect(spawned).toHaveLength(2);
    spawned[1].child.emit("exit", 0);
  });
});
