import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  answeredAt, answeredBase, configPatch, externalUrl, httpsUpgrade, isPrivateHost, originOf, packConfig, pageKind, sameServer, serverAddress, sessionOf, unpackConfig,
  updateFeedProblem, updateFilesProblem, type Config, type Seal,
  noteOf,
} from "../src/guard";

const SETUP = "file:///C:/Users/Some%20One/AppData/Local/Programs/Ahoy/resources/app.asar/assets/setup.html";

describe("where the window may be, and which page may use the bridge", () => {
  test("the server's origin is compared whole: a look-alike host is not the server", () => {
    const server = "https://ahoy.example.com";
    expect(pageKind("https://ahoy.example.com/", server, SETUP)).toBe("server");
    expect(pageKind("https://ahoy.example.com/game/7?x=1#top", server, SETUP)).toBe("server");
    expect(pageKind("https://ahoy.example.com.evil.net/", server, SETUP)).toBeNull();
    expect(pageKind("https://ahoy.example.com@evil.net/", server, SETUP)).toBeNull();
    expect(pageKind("http://ahoy.example.com/", server, SETUP)).toBeNull();             // another scheme is another origin
    expect(pageKind("http://192.168.1.20:8790@evil.net/", "http://192.168.1.20:8790", SETUP)).toBeNull();
    expect(pageKind("http://192.168.1.20:8790/big", "http://192.168.1.20:8790/", SETUP)).toBe("server");
    expect(pageKind("http://192.168.1.20:879/", "http://192.168.1.20:8790", SETUP)).toBeNull();
    expect(pageKind("https://anything.example/", "", SETUP)).toBeNull();                 // no server: nothing is the server
    expect(pageKind("not a url", server, SETUP)).toBeNull();
  });
  test("of all files only the launcher's own setup page counts", () => {
    expect(pageKind(SETUP, "", SETUP)).toBe("setup");
    expect(pageKind(SETUP + "?x=1#y", "https://ahoy.example.com", SETUP)).toBe("setup");
    expect(pageKind(SETUP.replace("C:/Users", "c:/users"), "", SETUP)).toBe("setup");
    expect(pageKind("file:///C:/Users/Some%20One/Downloads/setup.html", "", SETUP)).toBeNull();
    expect(pageKind("file:///C:/Windows/System32/calc.exe", "", SETUP)).toBeNull();
    expect(pageKind("file://evil-host/Users/Some%20One/AppData/Local/Programs/Ahoy/resources/app.asar/assets/setup.html", "", SETUP)).toBeNull();
  });
  test("a folder with a % in its name: the setup page is itself by the address the window is given (pathToFileURL's)", () => {
    // main.ts loads the page by this very address; written as text (loadFile's way) the % stays bare and the two never match
    const url = pathToFileURL(join(tmpdir(), "pct 100% fun", "a%41b", "assets", "setup.html")).href;
    expect(url).toContain("/pct%20100%25%20fun/a%2541b/assets/setup.html");
    expect(pageKind(url, "", url)).toBe("setup");
    expect(pageKind(url + "?x=1", "https://ahoy.example.com", url)).toBe("setup");
    expect(pageKind(url.replace("a%2541b", "a%41b"), "", url)).toBeNull();          // that is the folder "aAb": another file
    expect(pageKind(url.replace("a%2541b", "aAb"), "", url)).toBeNull();
  });
  test("only http and https links are handed to the system browser", () => {
    expect(externalUrl("https://store.example/app/1")).toBe("https://store.example/app/1");
    expect(externalUrl("http://wiki.example/x")).toBe("http://wiki.example/x");
    for (const bad of ["file:///C:/Users/x/setup.exe", "file://attacker-host/share/setup.exe", "search-ms:query=x", "ms-settings:display", "\\\\host\\share\\x.exe", "javascript:alert(1)", "steam://run/1", "", "C:\\x.exe", null, 7])
      expect(externalUrl(bad), String(bad)).toBeNull();
  });
});

describe("the server's address", () => {
  test("an address is http(s) with a host and nothing baked in", () => {
    expect(serverAddress(" https://ahoy.example.com/ ")).toBe("https://ahoy.example.com");
    expect(serverAddress("http://192.168.1.20:8790")).toBe("http://192.168.1.20:8790");
    for (const bad of ["ahoy.example.com", "ftp://x", "file:///C:/x", "https://user:pw@x.example", "https://x.example/?a=1", 42, null, {}, ""]) expect(serverAddress(bad), String(bad)).toBeNull();
  });
  test("a server that sends http on to https is kept by the address it answered at", () => {
    expect(answeredBase("http://ahoy.example.com", "https://ahoy.example.com/api/health")).toBe("https://ahoy.example.com");
    expect(answeredBase("http://ahoy.example.com/", "http://ahoy.example.com/api/health")).toBe("http://ahoy.example.com");
    expect(answeredBase("https://x.example/ahoy", "https://x.example/ahoy/api/health")).toBe("https://x.example/ahoy");
    expect(answeredBase("https://x.example", undefined)).toBe("https://x.example");
    expect(httpsUpgrade("http://ahoy.example.com", "https://ahoy.example.com")).toBe(true);
    expect(httpsUpgrade("http://ahoy.example.com:8790", "https://ahoy.example.com")).toBe(true);
    expect(httpsUpgrade("http://ahoy.example.com", "https://other.example.com")).toBe(false);
    expect(httpsUpgrade("https://ahoy.example.com", "http://ahoy.example.com")).toBe(false);
    expect(originOf("https://a.example:8443/x")).toBe("https://a.example:8443");
    expect(originOf("file:///C:/x")).toBe("");
  });
  test("one server however its address is spelled: capital letters in the host, a default port written out, a slash", () => {
    expect(sameServer("http://Tower:8790", "http://tower:8790")).toBe(true);
    expect(sameServer("https://ahoy.example.com:443", "https://ahoy.example.com/")).toBe(true);
    expect(sameServer("http://AHOY.example.com:80/", "http://ahoy.example.com")).toBe(true);
    expect(sameServer("https://x.example/ahoy/", "https://X.example/ahoy")).toBe(true);
    // another scheme, host, port or path is another server; so is anything that is no address
    for (const [a, b] of [["http://ahoy.example.com", "https://ahoy.example.com"], ["http://tower:8790", "http://tower:8791"], ["https://x.example/ahoy", "https://x.example/other"],
      ["https://x.example/ahoy", "https://x.example/Ahoy"], ["https://ahoy.example.com", "https://ahoy.example.com.evil.net"], ["https://ahoy.example.com", "https://ahoy.example.com@evil.net"], ["", ""], ["tower", "tower"]] as const)
      expect(sameServer(a, b), `${a} ${b}`).toBe(false);
  });
  test("what a look at an address is taken for: itself as it was spelled, its https address, never another server", () => {
    // the answering address as fetch reports it: the host in small letters, a default port dropped
    expect(answeredAt("http://Tower:8790", "http://tower:8790/api/health")).toEqual({ url: "http://Tower:8790" });
    expect(answeredAt("https://ahoy.example.com:443/", "https://ahoy.example.com/api/health")).toEqual({ url: "https://ahoy.example.com:443" });
    expect(answeredAt("http://LOCALHOST:8790", "http://localhost:8790/api/health")).toEqual({ url: "http://LOCALHOST:8790" });
    expect(answeredAt("https://x.example/ahoy", "https://x.example/ahoy/api/health")).toEqual({ url: "https://x.example/ahoy" });
    expect(answeredAt("https://x.example", undefined)).toEqual({ url: "https://x.example" });
    // sent on from http to https on the same host: the one move taken without asking
    expect(answeredAt("http://Ahoy.example.com", "https://ahoy.example.com/api/health")).toEqual({ url: "https://ahoy.example.com" });
    // sent on anywhere else: named, not taken
    expect(answeredAt("http://ahoy.example.com", "https://evil.example/api/health")).toEqual({ sendsTo: "https://evil.example" });
    expect(answeredAt("http://127.0.0.1:8790", "http://127.0.0.1:9000/api/health")).toEqual({ sendsTo: "http://127.0.0.1:9000" });
    expect(answeredAt("https://ahoy.example.com", "http://ahoy.example.com/api/health")).toEqual({ sendsTo: "http://ahoy.example.com" });     // down to http is no upgrade
    expect(answeredAt("https://x.example", "https://x.example/elsewhere/api/health")).toEqual({ sendsTo: "https://x.example/elsewhere" });
  });
});

describe("where updates may come from", () => {
  test("https always; plain http only from this PC or its own network", () => {
    for (const ok of ["https://ahoy.example.com", "http://192.168.1.20:8790", "http://10.0.0.5", "http://172.20.1.1:8790", "http://127.0.0.1:8790", "http://localhost:8790", "http://tower:8790", "http://tower.local:8790", "http://[::1]:8790", "http://[fd12:3456::1]:8790", "http://100.101.102.103:8790"])
      expect(updateFeedProblem(ok), ok).toBeNull();
    for (const bad of ["http://ahoy.example.com", "http://ahoy.example.com:8790", "http://8.8.8.8:8790", "http://172.32.0.1", "http://192.169.1.1", "http://[2001:db8::1]:8790", "http://100.128.0.1"])
      expect(updateFeedProblem(bad), bad).toMatch(/not https/);
    expect(updateFeedProblem("")).not.toBeNull();
    expect(isPrivateHost("192.168.1.20.evil.net")).toBe(false);
    expect(isPrivateHost("999.1.1.1")).toBe(false);
  });
  test("a build is downloaded only from the feed's own address, and only with its sha512", () => {
    const feed = "https://ahoy.example.com/launcher";
    const sha512 = Buffer.alloc(64, 7).toString("base64");
    expect(updateFilesProblem({ files: [{ url: "Ahoy-Setup-1.0.0.exe", sha512 }] }, feed)).toBeNull();
    expect(updateFilesProblem({ files: [{ url: "https://ahoy.example.com/launcher/Ahoy-Setup-1.0.0.exe", sha512 }] }, feed)).toBeNull();
    expect(updateFilesProblem({ files: [{ url: "https://evil.example/Ahoy-Setup-1.0.0.exe", sha512 }] }, feed)).toMatch(/another address/);
    expect(updateFilesProblem({ files: [{ url: "//evil.example/x.exe", sha512 }] }, feed)).toMatch(/another address/);
    expect(updateFilesProblem({ files: [{ url: "http://ahoy.example.com/launcher/x.exe", sha512 }] }, feed)).toMatch(/another address/);
    expect(updateFilesProblem({ files: [{ url: "Ahoy-Setup-1.0.0.exe" }] }, feed)).toMatch(/checksum/);
    expect(updateFilesProblem({ files: [{ url: "Ahoy-Setup-1.0.0.exe", sha512: "abc" }] }, feed)).toMatch(/checksum/);
    expect(updateFilesProblem({ files: [] }, feed)).toMatch(/no file/);
    expect(updateFilesProblem(null, feed)).toMatch(/no file/);
  });
});

describe("what a page may put into the settings", () => {
  const dir = join(tmpdir(), "Games");
  test("only the settings, each of its own kind; every other key is dropped", () => {
    expect(configPatch({ serverUrl: "https://ahoy.example.com/", libraryDir: dir, desktopShortcuts: false, padButton: "big", token: "stolen", user: "admin", extra: 1 }))
      .toEqual({ patch: { serverUrl: "https://ahoy.example.com", libraryDir: dir, desktopShortcuts: false, padButton: "big" } });
    for (const b of ["off", "show", "big"] as const) expect(configPatch({ padButton: b })).toEqual({ patch: { padButton: b } });
    expect(configPatch({ background: false, startWithWindows: true, syncSaves: false })).toEqual({ patch: { background: false, startWithWindows: true, syncSaves: false } });
    for (const bad of [{ background: "yes" }, { background: 1 }, { startWithWindows: null }, { startWithWindows: "on" }, { syncSaves: "no" }, { syncSaves: 0 }]) expect("error" in configPatch(bad), JSON.stringify(bad)).toBe(true);
    expect(configPatch({ serverUrl: "" })).toEqual({ patch: { serverUrl: "" } });
    expect(configPatch({})).toEqual({ patch: {} });
    expect(configPatch(null)).toEqual({ patch: {} });
  });
  test("a wrong value is refused, not saved", () => {
    for (const bad of [{ libraryDir: 42 }, { libraryDir: "" }, { libraryDir: "Games" }, { libraryDir: "..\\x" }, { libraryDir: null }, { serverUrl: 7 }, { serverUrl: "file:///C:/x" }, { serverUrl: "javascript:alert(1)" }, { desktopShortcuts: "yes" }, { padButton: "always" }, { padButton: true }, { padButton: "" }, { padButton: null }])
      expect("error" in configPatch(bad), JSON.stringify(bad)).toBe(true);
  });
  test("a session is a token and a name, as text", () => {
    expect(sessionOf({ token: "abc", user: "sam" })).toEqual({ token: "abc", user: "sam" });
    expect(sessionOf(null)).toEqual({ token: "", user: "" });
    expect(sessionOf({ token: 42, user: "sam" })).toEqual({ token: "", user: "" });
    expect(sessionOf({ token: "abc", user: { a: 1 } })).toEqual({ token: "abc", user: "" });
  });
});

describe("the settings file", () => {
  const def: Config = { serverUrl: "", libraryDir: join(tmpdir(), "Games", "Ahoy"), desktopShortcuts: true, padButton: "off", background: true, startWithWindows: false, syncSaves: true, token: "", user: "" };
  const seal: Seal = { available: () => true, seal: t => Buffer.from("sealed:" + t).toString("base64"), open: s => { const t = Buffer.from(s, "base64").toString(); if (!t.startsWith("sealed:")) throw new Error("not mine"); return t.slice(7); } };
  const c: Config = { serverUrl: "https://ahoy.example.com", libraryDir: join(tmpdir(), "D", "Games"), desktopShortcuts: false, padButton: "big", background: false, startWithWindows: true, syncSaves: false, token: "secret-token", user: "sam" };
  test("the session token never goes to disk in the clear while sealing works, and comes back", () => {
    const disk = JSON.stringify(packConfig(c, seal));
    expect(disk).not.toContain("secret-token");
    expect(JSON.parse(disk).token).toBeUndefined();
    expect(unpackConfig(JSON.parse(disk), def, seal)).toEqual(c);
  });
  test("without sealing it is kept as before; a file from before sealing still signs in", () => {
    expect(unpackConfig(JSON.parse(JSON.stringify(packConfig(c))), def)).toEqual(c);
    expect(unpackConfig({ ...c }, def, seal)).toEqual(c);
  });
  test("a sealed token that cannot be opened signs out; the rest stays", () => {
    expect(unpackConfig({ ...c, token: undefined, tokenSealed: "bm9wZQ==" }, def, seal)).toEqual({ ...c, token: "", user: "" });
  });
  test("a wrong value in the file is the default, not a crash later", () => {
    expect(unpackConfig({ serverUrl: 5, libraryDir: 42, desktopShortcuts: "x", padButton: "sometimes", token: 1, user: 2 }, def, seal)).toEqual(def);
    // a file from before the pad's home button had a setting: the button does nothing until it is asked to
    const old = JSON.parse(JSON.stringify(packConfig(c))); delete old.padButton;
    expect(unpackConfig(old, def).padButton).toBe("off");
    // a file from before Ahoy could stay by the clock: it does from now, and does not start with Windows until asked to
    const older = JSON.parse(JSON.stringify(packConfig(c))); delete older.background; delete older.startWithWindows; delete older.syncSaves;
    expect(unpackConfig(older, def)).toMatchObject({ background: true, startWithWindows: false, syncSaves: true });
    expect(unpackConfig({ ...c, background: "x", startWithWindows: 1, syncSaves: "y" }, def)).toMatchObject({ background: true, startWithWindows: false, syncSaves: true });
    expect(unpackConfig("garbage", def, seal)).toEqual(def);
    // the API-key era: the address is not an Ahoy server
    expect(unpackConfig({ ...c, apiKey: "k" }, def, seal)).toMatchObject({ serverUrl: "", token: "", user: "", libraryDir: c.libraryDir });
  });
});

describe("what a page may say in a notification", () => {
  test("a title, a line under it, and one of the app's own pages to open", () => {
    expect(noteOf({ title: "Hades is ready to play", body: "Installed", route: "/game/31" })).toEqual({ title: "Hades is ready to play", body: "Installed", route: "/game/31" });
    expect(noteOf({ title: "  Hades\nis here\u0007 ", extra: 1 })).toEqual({ title: "Hades is here", body: "", route: null });
    expect(noteOf({ title: "x".repeat(500), body: "y".repeat(500) })).toMatchObject({ title: "x".repeat(120), body: "y".repeat(200) });
  });
  test("no title is no notification; a route that is not a page of the app is none", () => {
    for (const bad of [null, "text", {}, { title: "" }, { title: "   " }, { title: 42 }, { body: "only a body" }]) expect(noteOf(bad)).toBeNull();
    for (const route of ["https://evil.example/", "//evil.example/x", "game/31", "/game/31?x=1", "/a b", "/..%2f", "javascript:alert(1)", 31, null, "/" + "a".repeat(300)])
      expect(noteOf({ title: "t", route })?.route, String(route)).toBeNull();
    for (const route of ["/", "/library", "/game/31", "/u/kay_o-1"]) expect(noteOf({ title: "t", route })?.route).toBe(route);
  });
});
