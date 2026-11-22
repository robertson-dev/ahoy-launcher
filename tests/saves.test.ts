/**
 * A game's saves on a PC (bun test): what the rules find (src/saves.ts scan), the digest two PCs agree by, a version packed
 * and put back on another PC, and what is never taken or written. Then the same in step with a server (src/savesync.ts): a
 * stand-in for the server keeps versions in memory.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { open } from "node:fs/promises";
import { MARK, allowedBy, digestOf, hashAll, pack, placeOf, readList, restore, ruleFor, ruleParts, rulesOf, scan, takeable, type Places, type Rules } from "../src/saves";
import { PART, Saves, type GameOnPc } from "../src/savesync";

const top = mkdtempSync(join(tmpdir(), "ahoy-saves-"));
afterAll(() => { try { rmSync(top, { recursive: true, force: true }); } catch { /* temp */ } });
let n = 0;
/** a PC of its own: every place a folder under one temp folder */
function pc(name = `pc${++n}`) {
  const root = join(top, name);
  const at = (p: string) => join(root, p);
  const places: Places = { base: at("Games/Hades"), home: at("Users/kay"), winAppData: at("Users/kay/AppData/Roaming"), winLocalAppData: at("Users/kay/AppData/Local"), winDocuments: at("Users/kay/Documents"), winPublic: at("Users/Public"), winProgramData: at("ProgramData"), osUserName: "kay" };
  for (const d of Object.values(places)) if (d && d !== "kay") mkdirSync(d, { recursive: true });
  const put = (place: keyof Places, rel: string, text = rel, when?: number) => {
    const f = join(places[place] as string, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, text);
    if (when) utimesSync(f, new Date(when), new Date(when));
    return f;
  };
  const read = (place: keyof Places, rel: string) => { try { return readFileSync(join(places[place] as string, rel), "utf8"); } catch { return null; } };
  return { root, places, put, read, data: join(root, "launcher-data") };
}
const rules = (paths: string[], more: Partial<Rules> = {}): Rules => ({ paths, exclude: [], made: false, ...more });
const names = (s: { files: { p: string }[] }) => s.files.map(f => f.p);
beforeEach(() => { n++; });

describe("a rule", () => {
  test("starts at a place and names something under it", () => {
    expect(ruleParts("<winDocuments>/Saved Games/Hades")).toEqual({ place: "winDocuments", segs: ["Saved Games", "Hades"] });
    expect(ruleParts("<base>/**/413150/remote")?.segs).toEqual(["**", "413150", "remote"]);
    for (const bad of ["<home>", "<home>/", "<base>/**", "<winAppData>/*", "<home>/../x", "<home>/a//b", "<home>/a\\b", "<nope>/x", "C:/x", "<home>/x:y", "<home>/[a]", "<home>/x**/y", "<root>/userdata/1/2/remote", 7, null, ""])
      expect(ruleParts(bad), String(bad)).toBeNull();
  });
  test("what a page hands over is taken only as far as it is rules", () => {
    expect(rulesOf({ paths: ["<home>/Saves", "<home>", 42, "C:/Windows"], exclude: ["**/*.log", "../x", 9], made: "yes", extra: 1 })).toEqual({ paths: ["<home>/Saves"], exclude: ["**/*.log"], made: false });
    expect(rulesOf(null)).toEqual({ paths: [], exclude: [], made: false });
    expect(rulesOf({ made: true }).made).toBe(true);
  });
});

describe("finding a game's saves", () => {
  test("a folder stands for everything in it; a wildcard picks by name; ** goes any folders down", async () => {
    const a = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav"); a.put("winDocuments", "Saved Games/Hades/deep/Profile2.sav"); a.put("winDocuments", "Saved Games/Other/x.sav");
    a.put("home", "AppData/LocalLow/Team Cherry/Hollow Knight/user1.dat"); a.put("home", "AppData/LocalLow/Team Cherry/Hollow Knight/user1.dat.bak1"); a.put("home", "AppData/LocalLow/Team Cherry/Hollow Knight/config.ini");
    a.put("base", "bin/x64/steam_settings/1145360/remote/slot.sav"); a.put("base", "bin/x64/steam_settings/999/remote/other.sav");
    expect(names(await scan(rules(["<winDocuments>/Saved Games/Hades"]), a.places))).toEqual(["<winDocuments>/Saved Games/Hades/deep/Profile2.sav", "<winDocuments>/Saved Games/Hades/Profile1.sav"]);
    expect(names(await scan(rules(["<home>/AppData/LocalLow/Team Cherry/Hollow Knight/*.dat"]), a.places))).toEqual(["<home>/AppData/LocalLow/Team Cherry/Hollow Knight/user1.dat"]);
    expect(names(await scan(rules(["<base>/**/1145360/remote"]), a.places))).toEqual(["<base>/bin/x64/steam_settings/1145360/remote/slot.sav"]);
    const s = await scan(rules(["<winDocuments>/Saved Games/Hades", "<winDocuments>/Nothing Here", "<winAppData>/Goldberg SteamEmu Saves/1145360"]), a.places);
    expect(s.where).toEqual(["<winDocuments>/Saved Games/Hades"]);
    expect(s).toMatchObject({ tooBig: false, bytes: "Saved Games/Hades/Profile1.sav".length + "Saved Games/Hades/deep/Profile2.sav".length });
  });
  test("the folders kept by app id, each with whatever name the copy gave them", async () => {
    const a = pc();
    a.put("winAppData", "Goldberg SteamEmu Saves/1145360/remote/save.dat"); a.put("winAppData", "Goldberg SteamEmu Saves/1145360/achievements.json"); a.put("winAppData", "Goldberg SteamEmu Saves/settings/account_name.txt");
    a.put("winProgramData", "Steam/RLD!/1145360/storage/a.sav"); a.put("winProgramData", "Steam/Peggle/userdata/x.dat");
    a.put("winPublic", "Documents/Steam/CODEX/1145360/remote/b.sav");
    const s = await scan(rules(["<winAppData>/Goldberg SteamEmu Saves/1145360", "<winProgramData>/Steam/*/1145360", "<winPublic>/Documents/Steam/CODEX/1145360"]), a.places);
    expect(names(s)).toEqual(["<winAppData>/Goldberg SteamEmu Saves/1145360/achievements.json", "<winAppData>/Goldberg SteamEmu Saves/1145360/remote/save.dat", "<winProgramData>/Steam/RLD!/1145360/storage/a.sav", "<winPublic>/Documents/Steam/CODEX/1145360/remote/b.sav"]);
  });
  test("the account's name inside a path is written as <osUserName>, so the save is the same save on a PC that calls it something else", async () => {
    const a = pc(), b = pc();
    b.places.osUserName = "couch";
    a.put("winDocuments", "Games/kay/slot.sav", "x"); b.put("winDocuments", "Games/couch/slot.sav", "x");
    const r = rules(["<winDocuments>/Games/<osUserName>"]);
    expect(names(await scan(r, a.places))).toEqual(["<winDocuments>/Games/<osUserName>/slot.sav"]);
    expect(names(await scan(r, b.places))).toEqual(["<winDocuments>/Games/<osUserName>/slot.sav"]);
    expect(placeOf("<winDocuments>/Games/<osUserName>/slot.sav", b.places)?.abs).toBe(join(b.places.winDocuments!, "Games", "couch", "slot.sav"));
    expect(placeOf("<winDocuments>/Games/<osUserName>/slot.sav", { ...b.places, osUserName: "" })).toBeNull();
  });
  test("inside the game's folder: its keep globs, never the files it was installed with", async () => {
    const a = pc();
    a.put("base", "Hades.exe"); a.put("base", "Content/data.pak"); a.put("base", "saves/slot1.sav"); a.put("base", "saves/shipped-default.sav"); a.put("base", "settings.ini"); a.put("base", "notes.txt");
    const installed = ["Hades.exe", "Content/data.pak", "saves/shipped-default.sav", "settings.ini"];
    expect(names(await scan(rules([]), a.places, { keep: ["saves/**"], installed }))).toEqual(["<base>/saves/shipped-default.sav", "<base>/saves/slot1.sav"]);
    // a rule that names a folder the package ships files in finds what the game wrote there, not what was shipped
    expect(names(await scan(rules(["<base>/saves", "<base>/settings.ini"]), a.places, { installed }))).toEqual(["<base>/saves/slot1.sav"]);
    expect(names(await scan(rules([]), a.places, { installed }))).toEqual([]);
  });
  test("a game nobody has rules for: what it made in its own folder, without logs, dumps and caches", async () => {
    const a = pc();
    a.put("base", "Game.exe"); a.put("base", "data/level1.pak"); a.put("base", "profile/slot1.sav"); a.put("base", "config.ini"); a.put("base", "output_log.txt"); a.put("base", "logs/run.log");
    a.put("base", "crashes/1.dmp"); a.put("base", "ShaderCache/a.bin"); a.put("base", "helper.exe"); a.put("base", "GPUCache/data_0");
    const installed = ["Game.exe", "data/level1.pak"];
    expect(names(await scan(rules([], { made: true }), a.places, { installed }))).toEqual(["<base>/config.ini", "<base>/profile/slot1.sav"]);
    // without knowing what was installed, nothing can be told apart from the game itself
    expect(names(await scan(rules([], { made: true }), a.places, { installed: null }))).toEqual([]);
    expect(names(await scan(rules([], { made: false }), a.places, { installed }))).toEqual([]);
    // much of it is content the game fetched or unpacked, not progress: none of it is taken
    expect(names(await scan(rules([], { made: true }), a.places, { installed, limits: { madeTotal: 10 } }))).toEqual([]);
    expect(names(await scan(rules([], { made: true }), a.places, { installed, limits: { madeFiles: 1 } }))).toEqual([]);
    expect(names(await scan(rules([], { made: true }), a.places, { installed, limits: { madeFile: 12 } }))).toEqual(["<base>/config.ini"]);
  });
  test("never a program, script or shortcut; never what browsers and key stores keep; never through a link", async () => {
    const a = pc();
    a.put("winDocuments", "Saves/slot.sav"); a.put("winDocuments", "Saves/tool.exe"); a.put("winDocuments", "Saves/run.bat"); a.put("winDocuments", "Saves/Game.lnk"); a.put("winDocuments", "Saves/mod.dll");
    a.put("home", ".ssh/id_ed25519"); a.put("winLocalAppData", "Google/Chrome/User Data/Default/Login Data"); a.put("winAppData", "Microsoft/Credentials/abc");
    const secret = join(a.root, "elsewhere"); mkdirSync(secret, { recursive: true }); writeFileSync(join(secret, "private.txt"), "x");
    symlinkSync(secret, join(a.places.winDocuments!, "Saves", "linked"), "junction");
    symlinkSync(secret, join(a.places.winDocuments!, "LinkedSaves"), "junction");
    const s = await scan(rules(["<winDocuments>/Saves", "<winDocuments>/LinkedSaves", "<winDocuments>/LinkedSaves/private.txt", "<home>/.ssh", "<winLocalAppData>/Google/Chrome/User Data", "<winAppData>/Microsoft/Credentials"]), a.places);
    expect(names(s)).toEqual(["<winDocuments>/Saves/slot.sav"]);
    for (const p of ["<home>/x/a.exe", "<home>/x/a.PS1", "<home>/.ssh/key", "<winAppData>/Microsoft/Windows/Start Menu/Programs/Startup/x.txt", "<winAppData>/Mozilla/Firefox/Profiles/a/logins.json", "<home>/x/save.dat.ahoy-new"]) expect(takeable(p), p).toBe(false);
    for (const p of ["<home>/Saved Games/x/slot1.sav", "<winAppData>/Game/profile.json", "<base>/saves/a.dat"]) expect(takeable(p), p).toBe(true);
  });
  test("what the rules exclude is left out; more than is kept in step is not synced at all", async () => {
    const a = pc();
    a.put("winAppData", "GSE Saves/7/remote/a.sav"); a.put("winAppData", "GSE Saves/7/screenshots/1.jpg"); a.put("winAppData", "GSE Saves/7/achievement_images/x.png"); a.put("winAppData", "GSE Saves/7/emu.log");
    const r = rules(["<winAppData>/GSE Saves/7"], { exclude: ["**/screenshots/**", "**/achievement_images/**", "**/*.log"] });
    expect(names(await scan(r, a.places))).toEqual(["<winAppData>/GSE Saves/7/remote/a.sav"]);
    for (const limits of [{ files: 2 }, { total: 5 }, { file: 3 }]) expect(await scan(rules(["<winAppData>/GSE Saves/7"]), a.places, { limits })).toMatchObject({ tooBig: true, files: [] });
  });
});

describe("the digest", () => {
  test("is the same on two PCs with the same saves, wherever their places are, whenever they were written, whatever the letter case", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "progress", 1_700_000_000_000);
    b.put("winDocuments", "saved games/hades/profile1.SAV", "progress", 1_600_000_000_000);
    const r = rules(["<winDocuments>/Saved Games/Hades"]);
    const da = digestOf((await hashAll((await scan(r, a.places)).files)).list), dbb = digestOf((await hashAll((await scan(r, b.places)).files)).list);
    expect(da).toMatch(/^[0-9a-f]{64}$/);
    expect(dbb).toBe(da);
    b.put("winDocuments", "saved games/hades/profile1.SAV", "PROGRESS");
    expect(digestOf((await hashAll((await scan(r, b.places)).files)).list)).not.toBe(da);
    expect(digestOf([])).toBeNull();
  });
  test("a file that has not changed is not read again", async () => {
    const a = pc();
    const f = a.put("winDocuments", "Saves/slot.sav", "one", 1_700_000_000_000);
    const first = await hashAll((await scan(rules(["<winDocuments>/Saves"]), a.places)).files);
    const lie: typeof first.hashes = { "<windocuments>/saves/slot.sav": [3, 1_700_000_000_000, "f".repeat(64)] };
    expect((await hashAll((await scan(rules(["<winDocuments>/Saves"]), a.places)).files, lie)).list[0]!.h).toBe("f".repeat(64));
    writeFileSync(f, "two!");
    expect((await hashAll((await scan(rules(["<winDocuments>/Saves"]), a.places)).files, lie)).list[0]!.h).not.toBe("f".repeat(64));
  });
});

describe("a version, packed and put back", () => {
  const R = rules(["<winDocuments>/Saved Games/Hades", "<winAppData>/GSE Saves/1145360", "<base>/**/1145360/remote"]);
  async function packed(a: ReturnType<typeof pc>, r = R, o = {}) {
    const to = join(a.root, "out.sav");
    const found = await scan(r, a.places, o);
    return { to, ...(await pack(found.files, to)) };
  }
  test("on another PC the saves are the same files, with the times they were written at", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "p1 " + "x".repeat(5000), 1_700_000_000_000); a.put("winDocuments", "Saved Games/Hades/empty.sav", "");
    a.put("winAppData", "GSE Saves/1145360/remote/cloud.dat", "cloud"); a.put("base", "x64/steam_settings/1145360/remote/local.dat", "local");
    const p = await packed(a);
    expect(p.entries.map(e => e.p)).toEqual(["<base>/x64/steam_settings/1145360/remote/local.dat", "<winAppData>/GSE Saves/1145360/remote/cloud.dat", "<winDocuments>/Saved Games/Hades/empty.sav", "<winDocuments>/Saved Games/Hades/Profile1.sav"]);
    expect(p.size).toBeLessThan(5000);                                          // deflated
    expect(readFileSync(p.to).subarray(-8).toString()).toBe(MARK);
    const r = await restore(p.to, R, b.places, { backupDir: join(b.data, "bk") });
    expect(r).toMatchObject({ written: 4, removed: 0, skipped: 0, backup: null });
    expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("p1 " + "x".repeat(5000));
    expect(b.read("winDocuments", "Saved Games/Hades/empty.sav")).toBe("");
    expect(b.read("winAppData", "GSE Saves/1145360/remote/cloud.dat")).toBe("cloud");
    expect(b.read("base", "x64/steam_settings/1145360/remote/local.dat")).toBe("local");
    expect(Math.round(statSync(join(b.places.winDocuments!, "Saved Games/Hades/Profile1.sav")).mtimeMs)).toBe(1_700_000_000_000);
    // and the two PCs now agree
    const db2 = digestOf((await hashAll((await scan(R, b.places)).files)).list);
    expect(db2).toBe(p.digest);
    expect(readdirSync(join(b.places.winDocuments!, "Saved Games/Hades")).sort()).toEqual(["Profile1.sav", "empty.sav"]);   // nothing left beside them
  });
  test("what it replaces is copied aside first; a save both agreed on that the version no longer has goes too, nothing else", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "newer");
    b.put("winDocuments", "Saved Games/Hades/Profile1.sav", "older"); b.put("winDocuments", "Saved Games/Hades/Profile2.sav", "deleted on the other PC"); b.put("winDocuments", "Saved Games/Hades/Profile3.sav", "only ever here");
    const p = await packed(a);
    const bk = join(b.data, "bk");
    const r = await restore(p.to, R, b.places, { backupDir: bk, agreed: ["<winDocuments>/Saved Games/Hades/Profile1.sav", "<WINDOCUMENTS>/saved games/hades/profile2.sav", "<winDocuments>/Saved Games/Elsewhere/never.sav"] });
    expect(r).toMatchObject({ written: 1, removed: 1, backup: bk });
    expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("newer");
    expect(b.read("winDocuments", "Saved Games/Hades/Profile2.sav")).toBeNull();
    expect(b.read("winDocuments", "Saved Games/Hades/Profile3.sav")).toBe("only ever here");
    expect(readFileSync(join(bk, "winDocuments/Saved Games/Hades/Profile1.sav"), "utf8")).toBe("older");
    expect(readFileSync(join(bk, "winDocuments/Saved Games/Hades/Profile2.sav"), "utf8")).toBe("deleted on the other PC");
  });
  test("a save the rules here do not speak of, a program, or a file of the game's own package is not written", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "ok"); a.put("winDocuments", "Other Game/slot.sav", "other"); a.put("base", "made.cfg", "made"); a.put("base", "Content/data.pak", "changed there");
    const wide = rules(["<winDocuments>/Saved Games/Hades", "<winDocuments>/Other Game"], { made: true });
    const p = await packed(a, wide, { installed: ["Hades.exe"] });
    expect(p.entries.length).toBe(4);
    b.put("base", "Content/data.pak", "the game's own");
    // here: the narrower rules, made files allowed, and data.pak is part of the package
    const r = await restore(p.to, rules(["<winDocuments>/Saved Games/Hades"], { made: true }), b.places, { backupDir: join(b.data, "bk"), installed: ["Hades.exe", "Content/data.pak"] });
    expect(r).toMatchObject({ written: 2, skipped: 2 });
    expect(b.read("winDocuments", "Other Game/slot.sav")).toBeNull();
    expect(b.read("base", "Content/data.pak")).toBe("the game's own");
    expect(b.read("base", "made.cfg")).toBe("made");
    const ok = allowedBy(rules(["<winDocuments>/Saved Games/Hades", "<base>/**/7/remote", "<winDocuments>/x/*.sav"]), { keep: ["saves/**"], installed: ["a.bin"] });
    expect(["<winDocuments>/Saved Games/Hades/a/b.sav", "<winDocuments>/saved games/hades/b.sav", "<base>/x/y/7/remote/s.dat", "<base>/7/remote/s.dat", "<base>/saves/q.sav", "<winDocuments>/x/1.sav"].map(ok)).toEqual([true, true, true, true, true, true]);
    expect(["<winDocuments>/Saved Games/Hades2/b.sav", "<winDocuments>/Saved Games", "<base>/x/8/remote/s.dat", "<base>/a.bin", "<base>/other.cfg", "<winDocuments>/x/1.txt", "<winAppData>/Saved Games/Hades/b.sav", "nonsense"].map(ok)).toEqual([false, false, false, false, false, false, false, false]);
  });
  test("a version that names a path out of its place, or through a link, writes nothing there", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "ok");
    const p = await packed(a);
    // the same pack with its one name changed to climb out (the list is at its end, the body before it)
    const raw = readFileSync(p.to), len = raw.readUInt32LE(raw.length - 12), listAt = raw.length - 12 - len;
    const forge = (name: string) => {
      const list = Buffer.from(JSON.stringify({ v: 1, files: p.entries.map(e => ({ ...e, p: name })) })), l = Buffer.alloc(4);
      l.writeUInt32LE(list.length);
      const f = join(a.root, "forged.sav");
      writeFileSync(f, Buffer.concat([raw.subarray(0, listAt), list, l, Buffer.from(MARK)]));
      return f;
    };
    const outside = join(b.root, "outside.sav");
    for (const name of ["<winDocuments>/Saved Games/Hades/../../../../outside.sav", "<winDocuments>/../outside.sav", "C:/outside.sav", "<winDocuments>/Saved Games/Hades/evil.exe", "<nowhere>/x.sav", "<winDocuments>/Saved Games/Hades/a:b.sav"]) {
      const r = await restore(forge(name), R, b.places, { backupDir: join(b.data, "bk") });
      expect(r, name).toMatchObject({ written: 0, skipped: 1 });
    }
    expect(existsSync(outside)).toBe(false);
    // a link where the saves' folder would be: nothing is written through it
    const elsewhere = join(b.root, "elsewhere"); mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(b.places.winDocuments!, "Saved Games"), { recursive: true });
    symlinkSync(elsewhere, join(b.places.winDocuments!, "Saved Games", "Hades"), "junction");
    expect(await restore(p.to, R, b.places, { backupDir: join(b.data, "bk") })).toMatchObject({ written: 0, skipped: 1 });
    expect(readdirSync(elsewhere)).toEqual([]);
  });
  test("a version that is not whole changes nothing on this PC", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "new one"); a.put("winDocuments", "Saved Games/Hades/Profile2.sav", "new two " + "y".repeat(400));
    b.put("winDocuments", "Saved Games/Hades/Profile1.sav", "old one");
    const p = await packed(a);
    const raw = readFileSync(p.to);
    const broken = Buffer.from(raw); broken[raw.length - 12 - raw.readUInt32LE(raw.length - 12) - 3] ^= 0xff;      // a byte of the last save's body
    writeFileSync(p.to, broken);
    await expect(restore(p.to, R, b.places, { backupDir: join(b.data, "bk") })).rejects.toThrow(/did not arrive whole/);
    expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("old one");
    expect(readdirSync(join(b.places.winDocuments!, "Saved Games/Hades"))).toEqual(["Profile1.sav"]);
    for (const junk of [Buffer.from("not saves at all"), raw.subarray(0, raw.length - 3), Buffer.concat([Buffer.from(MARK), Buffer.from("{}"), Buffer.from([2, 0, 0, 0]), Buffer.from(MARK)])]) {
      writeFileSync(p.to, junk);
      await expect(restore(p.to, R, b.places, { backupDir: join(b.data, "bk") })).rejects.toThrow(/not a set of saves/);
    }
    const fh = await open(p.to, "r");
    try { await expect(readList(fh, 5)).rejects.toThrow(); } finally { await fh.close(); }
  });
  test("while the game holds a save open, nothing is replaced", async () => {
    const a = pc(), b = pc();
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "newer"); a.put("winDocuments", "Saved Games/Hades/Profile2.sav", "newer two");
    const f = b.put("winDocuments", "Saved Games/Hades/Profile2.sav", "in use");
    b.put("winDocuments", "Saved Games/Hades/Profile1.sav", "old");
    const p = await packed(a);
    if (process.platform !== "win32") return;                                   // only Windows refuses to open a file another holds
    const { openSync, closeSync } = await import("node:fs");
    // held the way a game holds its save: no sharing for writing
    const held = Bun.spawn(["powershell", "-NoProfile", "-Command", `$f=[System.IO.File]::Open('${f.replace(/'/g, "''")}','Open','ReadWrite','None'); Write-Output held; Start-Sleep -Seconds 20`], { stdout: "pipe" });
    try {
      const reader = held.stdout.getReader(); await reader.read(); reader.releaseLock();
      await expect(restore(p.to, R, b.places, { backupDir: join(b.data, "bk") })).rejects.toThrow(/holds its saves open/);
      expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("old");
    } finally { held.kill(); await held.exited; void openSync; void closeSync; }
  }, 30_000);
});

describe("a folder picked by hand, as a rule", () => {
  test("is written from the place that holds it: the game's folder first, never a whole place, never outside them", () => {
    const a = pc();
    expect(ruleFor(join(a.places.winDocuments!, "My Games", "Thing"), a.places)).toBe("<winDocuments>/My Games/Thing");
    expect(ruleFor(join(a.places.base!, "saves"), a.places)).toBe("<base>/saves");
    expect(ruleFor(join(a.places.winAppData!, "Thing"), a.places)).toBe("<winAppData>/Thing");
    expect(ruleFor(join(a.places.home!, "Saved Games", "Thing"), a.places)).toBe("<home>/Saved Games/Thing");
    expect(ruleFor(a.places.winDocuments!, a.places)).toBeNull();
    expect(ruleFor(a.places.home!, a.places)).toBeNull();
    expect(ruleFor(join(a.places.home!, "AppData"), a.places)).toBeNull();          // it holds two of the places whole
    expect(ruleFor(a.places.base!, a.places)).toBeNull();
    expect(ruleFor(join(a.root, "Somewhere Else"), a.places)).toBeNull();
    expect(ruleFor(join(a.places.home!, ".ssh"), a.places)).toBeNull();
  });
});

/* ─────────── in step with a server ─────────── */

/** a server that keeps versions as the real one does: by key, newest last, a version arriving in parts, in order; the same
 *  digest again is the same version */
function fakeServer() {
  const kept = new Map<string, { id: number; digest: string; body: Buffer; meta: any }[]>();
  const arriving = new Map<string, { next: number; chunks: Buffer[] }>();
  let next = 1, down = false;
  const calls: string[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input)), method = init?.method ?? "GET";
    calls.push(`${method} ${u.pathname}`);
    if (down) throw new TypeError("fetch failed");
    if (new Headers(init?.headers).get("authorization") !== "Bearer tok") return new Response(JSON.stringify({ error: "sign in first" }), { status: 401 });
    const m = /^\/api\/v1\/saves\/([ag]\d+)(?:\/(\d+))?$/.exec(u.pathname);
    if (!m) return new Response("{}", { status: 404 });
    const list = kept.get(m[1]!) ?? kept.set(m[1]!, []).get(m[1]!)!;
    if (method === "POST") {
      const meta = JSON.parse(decodeURIComponent(new Headers(init?.headers).get("x-ahoy-save")!));
      const [upload, index, count] = String(new Headers(init?.headers).get("x-ahoy-part")).split(":"), i = Number(index);
      const head = list.at(-1);
      if (i === 0 && head && head.digest === meta.digest) return new Response(JSON.stringify({ item: { id: head.id, digest: head.digest }, same: true }), { status: 201 });
      const body = Buffer.from(init!.body as Uint8Array);
      if (body.length > 1024 * 1024) return new Response(JSON.stringify({ error: "that part is too large" }), { status: 413 });
      if (i === 0) arriving.set(upload!, { next: 0, chunks: [] });
      const up = arriving.get(upload!);
      if (!up || up.next !== i) return new Response(JSON.stringify({ error: "these saves did not arrive in order: send them again" }), { status: 409 });
      up.chunks.push(body); up.next++;
      if (up.next < Number(count)) return new Response(JSON.stringify({ next: up.next }));
      arriving.delete(upload!);
      const v = { id: next++, digest: meta.digest, body: Buffer.concat(up.chunks), meta };
      list.push(v);
      return new Response(JSON.stringify({ item: { id: v.id, digest: v.digest }, same: false }), { status: 201 });
    }
    const v = list.find(x => x.id === Number(m[2]));
    return v ? new Response(v.body as unknown as BodyInit) : new Response(JSON.stringify({ error: "no such saves" }), { status: 404 });
  }) as typeof fetch;
  return { fetchFn, kept, calls, head: (key: string) => kept.get(key)?.at(-1) ?? null, set down(v: boolean) { down = v; } };
}
const R2 = { paths: ["<winDocuments>/Saved Games/Hades"], exclude: [], made: false };
function onPc(server: ReturnType<typeof fakeServer>, name: string) {
  const p = pc();
  const { base: _b, ...rest } = p.places;
  const saves = new Saves({ dataDir: p.data, places: () => rest, serverUrl: () => "http://ahoy.test/", token: () => "tok", device: () => name, fetch: server.fetchFn });
  const game: GameOnPc = { slug: "hades", path: p.places.base!, keep: [], installed: ["Hades.exe"] };
  return { ...p, saves, game };
}

describe("in step with the server", () => {
  test("played on one PC, taken on the other: the same saves, and both remember what they agreed on", async () => {
    const server = fakeServer();
    const a = onPc(server, "DESK"), b = onPc(server, "COUCH");
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "an evening's progress");
    const before = await a.saves.state(a.game, "a1145360", R2);
    expect(before).toMatchObject({ files: 1, base: null, tooBig: false, where: ["<winDocuments>/Saved Games/Hades"] });
    const pushed = await a.saves.push(a.game, "a1145360", R2, { gameId: 7, name: "Hades" });
    expect(pushed).toMatchObject({ digest: before.digest, same: false });
    expect(server.head("a1145360")!.meta).toMatchObject({ device: "DESK", files: 1, gameId: 7, name: "Hades", digest: before.digest });
    expect((await a.saves.state(a.game, "a1145360", R2)).base).toEqual({ id: pushed!.id, digest: pushed!.digest });
    // the couch has nothing yet
    expect(await b.saves.state(b.game, "a1145360", R2)).toMatchObject({ digest: null, files: 0, base: null });
    expect(await b.saves.pull(b.game, "a1145360", R2, pushed!.id)).toMatchObject({ written: 1, removed: 0, skipped: 0, digest: pushed!.digest });
    expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("an evening's progress");
    expect(await b.saves.state(b.game, "a1145360", R2)).toMatchObject({ digest: pushed!.digest, base: { id: pushed!.id, digest: pushed!.digest } });
    // nothing changed since: bringing them again is the same version, not another
    expect(await b.saves.push(b.game, "a1145360", R2)).toMatchObject({ id: pushed!.id, same: true });
    expect(server.kept.get("a1145360")!.length).toBe(1);
  });
  test("a save deleted on one PC goes on the other with the next version; one only the other has stays, and goes up next time", async () => {
    const server = fakeServer();
    const a = onPc(server, "DESK"), b = onPc(server, "COUCH");
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "one"); a.put("winDocuments", "Saved Games/Hades/Profile2.sav", "two");
    const v1 = await a.saves.push(a.game, "g7", R2);
    await b.saves.pull(b.game, "g7", R2, v1!.id);
    rmSync(join(a.places.winDocuments!, "Saved Games/Hades/Profile2.sav"));
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "one, further");
    const v2 = await a.saves.push(a.game, "g7", R2);
    b.put("winDocuments", "Saved Games/Hades/Scratch.sav", "made on the couch, never synced");
    expect(await b.saves.pull(b.game, "g7", R2, v2!.id)).toMatchObject({ written: 1, removed: 1 });
    expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("one, further");
    expect(b.read("winDocuments", "Saved Games/Hades/Profile2.sav")).toBeNull();
    expect(b.read("winDocuments", "Saved Games/Hades/Scratch.sav")).toBe("made on the couch, never synced");
    // what the pull replaced and removed is in a backup of the couch's own
    const bk = join(b.data, "save-backups", "g7");
    const stamps = readdirSync(bk);
    expect(stamps.length).toBe(1);
    expect(readFileSync(join(bk, stamps[0]!, "winDocuments/Saved Games/Hades/Profile2.sav"), "utf8")).toBe("two");
    // the couch now has one save more than the server: it differs from what they agreed on, and goes up as a version
    const st = await b.saves.state(b.game, "g7", R2);
    expect(st.digest).not.toBe(st.base!.digest);
    const v3 = await b.saves.push(b.game, "g7", R2);
    expect(v3!.same).toBe(false);
    expect(server.head("g7")!.meta).toMatchObject({ device: "COUCH", files: 2 });
  });
  test("this PC already has what the server has: they agree without anything moving", async () => {
    const server = fakeServer();
    const a = onPc(server, "DESK"), b = onPc(server, "COUCH");
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "same"); b.put("winDocuments", "Saved Games/Hades/Profile1.sav", "same");
    const v = await a.saves.push(a.game, "g7", R2);
    expect(await b.saves.agree(b.game, "g7", R2, { id: v!.id, digest: v!.digest })).toBe(true);
    expect((await b.saves.state(b.game, "g7", R2)).base).toEqual({ id: v!.id, digest: v!.digest });
    expect(await b.saves.agree(b.game, "g7", R2, { id: v!.id, digest: "0".repeat(64) })).toBe(false);
    expect(server.calls.filter(c => c.startsWith("GET")).length).toBe(0);
  });
  test("no saves here is nothing to bring; a server that is away, or refuses, changes nothing here", async () => {
    const server = fakeServer();
    const a = onPc(server, "DESK");
    expect(await a.saves.push(a.game, "g7", R2)).toBeNull();
    expect(server.calls).toEqual([]);
    a.put("winDocuments", "Saved Games/Hades/Profile1.sav", "x");
    server.down = true;
    await expect(a.saves.push(a.game, "g7", R2)).rejects.toMatchObject({ code: "server" });
    await expect(a.saves.pull(a.game, "g7", R2, 1)).rejects.toMatchObject({ code: "server" });
    server.down = false;
    expect((await a.saves.state(a.game, "g7", R2)).base).toBeNull();
    await expect(a.saves.pull(a.game, "g7", R2, 99)).rejects.toMatchObject({ code: "gone" });
    await expect(a.saves.pull(a.game, "g7", R2, 0)).rejects.toMatchObject({ code: "gone" });
    await expect(a.saves.state(a.game, "../x", R2)).rejects.toThrow(/no such game/);
    expect(a.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("x");
    expect(existsSync(join(a.data, "saves", "out-g7.part"))).toBe(false);
  });
  test("saves larger than one request brings go up in parts, and come back whole", async () => {
    const server = fakeServer();
    const a = onPc(server, "DESK"), b = onPc(server, "COUCH");
    // nothing a deflate can shrink: two megabytes that stay two megabytes
    const { randomBytes } = await import("node:crypto");
    const noise = randomBytes(2 * 1024 * 1024 + 4321);
    mkdirSync(join(a.places.winDocuments!, "Saved Games/Hades"), { recursive: true });
    writeFileSync(join(a.places.winDocuments!, "Saved Games/Hades/world.sav"), noise);
    const v = await a.saves.push(a.game, "g7", R2);
    const posts = server.calls.filter(c => c === "POST /api/v1/saves/g7").length;
    expect(posts).toBe(Math.ceil(server.head("g7")!.body.length / PART));
    expect(posts).toBeGreaterThan(3);
    await b.saves.pull(b.game, "g7", R2, v!.id);
    expect(readFileSync(join(b.places.winDocuments!, "Saved Games/Hades/world.sav")).equals(noise)).toBe(true);
  });
  test("only the last five backups of a game stay", async () => {
    const server = fakeServer();
    const a = onPc(server, "DESK"), b = onPc(server, "COUCH");
    let t = Date.UTC(2026, 10, 11, 12, 0, 0);
    const bSaves = new Saves({ dataDir: b.data, places: () => { const { base: _x, ...rest } = b.places; return rest; }, serverUrl: () => "http://ahoy.test", token: () => "tok", device: () => "COUCH", fetch: server.fetchFn, now: () => (t += 60_000) });
    b.put("winDocuments", "Saved Games/Hades/Profile1.sav", "start");
    for (let i = 1; i <= 7; i++) {
      a.put("winDocuments", "Saved Games/Hades/Profile1.sav", `turn ${i}`);
      const v = await a.saves.push(a.game, "g7", R2);
      await bSaves.pull(b.game, "g7", R2, v!.id);
    }
    const stamps = readdirSync(join(b.data, "save-backups", "g7")).sort();
    expect(stamps.length).toBe(5);
    expect(readFileSync(join(b.data, "save-backups", "g7", stamps[0]!, "winDocuments/Saved Games/Hades/Profile1.sav"), "utf8")).toBe("turn 2");
    expect(b.read("winDocuments", "Saved Games/Hades/Profile1.sav")).toBe("turn 7");
  });
});
