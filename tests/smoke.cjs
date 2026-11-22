/**
 * Ahoy launcher — the real main process against local stand-in servers (bun run smoke). No account, no real server,
 * nothing installed or started; the window never shows, and nothing is handed to the system browser (recorded instead).
 *
 * The walk: a saved server that does not answer → the setup page lists the games on this PC with Play, the list inside
 * its own room however many there are; the server comes back → the window returns to it by itself, still signed in; the
 * session goes to disk sealed, the file whole; a page may only set the three settings, each of its own kind, a folder only
 * after the folder dialog, another server only after the launcher's own question, which names the address it ends at; the
 * window does not follow a look-alike address or a redirect off the server; only http(s) links leave for the browser; a
 * page that is not the server's cannot use the bridge.
 *
 * Then, each as a start of its own (this file run again with SMOKE_CASE, a profile of its own):
 *   spelling    a saved address written with capital letters is the same server: its page, still signed in, its games its own
 *   sent-on     a saved server whose address sends on to another server is not followed, at the start or later; the setup
 *               page says where it leads, and only Connect for that address goes there
 *   setup-page  the setup page reaches the launcher when the app sits in a folder with a % in its name
 *   https       a server that answers its http address from https is kept by the https one, session and games with it
 *               (needs openssl for a throwaway certificate; says so and passes over it when there is none)
 *   big         started with --big the page is told so once; the page zooms itself, within bounds; a controller's home
 *               button is heard by a window that is never shown, only while the setting wants it, one press at a time,
 *               and asks the page for the big screen when the setting says so (the pad is the test's own)
 *   away        what 0.13 adds: the room on the games' drive; a notification is kept (never shown here) while the window is
 *               not in front, and clicking it tells the page which of its pages to open; closing the window leaves Ahoy
 *               running while the setting says so; a game's saves are found by the rules, brought to the server and put
 *               back from it (the server is the test's own), never with the setting off, never for a console dump
 * Exit code 0 only when every step passed. SMOKE_ROOT=<folder> runs a copy of the app from there. SMOKE_SHOT=<file.png> saves a picture of the setup page.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const https = require("https");
const { spawn, spawnSync } = require("child_process");

process.env.AHOY_HIDDEN = "1";
const CASE = process.env.SMOKE_CASE || "walk";
// the https case: its certificate is the test's own, so nothing vouches for it
if (CASE === "https") process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const electron = require("electron");
const { app, BrowserWindow, shell, dialog } = electron;
if (CASE === "https") app.commandLine.appendSwitch("ignore-certificate-errors");
// SMOKE_ROOT: a copy of dist/, assets/ and package.json somewhere else (a path with spaces and accents, as a user folder can have)
const root = process.env.SMOKE_ROOT || path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ahoy-smoke-"));
const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.setAppPath(root);

// nothing leaves the test: links and questions are recorded
const opened = [];
shell.openExternal = async url => { opened.push(url); };
const asked = [];
let answer = 0;                                                // what the person says to the launcher's question: 0 Cancel, 1 Connect
dialog.showMessageBox = async (_w, o) => { asked.push(o); return { response: answer }; };

const steps = [];
const ok = (name, detail = "") => { steps.push(`OK ${name}${detail ? " — " + detail : ""}`); console.log(steps.at(-1)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, every = 200) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await sleep(every); } };
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } };

const page = title => `<!doctype html><meta charset="utf-8"><title>${title}</title><h1>${title}</h1>`;
/** an Ahoy-looking server: health (sent on to `mode.sendsTo` while that is set), how package 1 starts, a page, and a
 *  redirect off to wherever ?to= says; `seen` gets every request */
const answers = (title, mode, seen) => (req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push(`${req.method} ${u.pathname}`);
  const json = body => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  if (u.pathname === "/api/health") {
    if (mode.sendsTo) { res.writeHead(302, { location: mode.sendsTo + "/api/health" }); return res.end(); }
    return json({ ok: true, app: "ahoy", version: "smoke" });
  }
  if (u.pathname === "/api/v1/package/1/launch") return json({ launch: { exe: "Pilot.exe", args: "", cwd: "" }, rev: null, requires: null, kind: "native" });
  if (u.pathname === "/away") { res.writeHead(302, { location: u.searchParams.get("to") }); return res.end(); }
  res.writeHead(200, { "content-type": "text/html" }); res.end(page(title));
};
const serve = (title, mode = {}, seen = []) => http.createServer(answers(title, mode, seen));
const listen = (srv, port = 0) => new Promise((res, rej) => { srv.once("error", rej); srv.listen(port, "127.0.0.1", () => res(srv.address().port)); });
/** a port nothing answers on (yet) */
const freePort = async () => { const s = http.createServer(); const p = await listen(s); await new Promise(r => s.close(r)); return p; };

const lib = path.join(tmp, "library");
const diskText = () => fs.readFileSync(path.join(userData, "config.json"), "utf8");
const disk = () => JSON.parse(diskText());
const installed = () => JSON.parse(fs.readFileSync(path.join(userData, "installed.json"), "utf8"));
/**
 * The launcher started with this saved address: a settings file from before the session was sealed, and one game on this
 * PC recorded under that address (its program is not there: Play must say so, not start anything), a console dump beside it.
 */
async function start(saved) {
  fs.mkdirSync(path.join(lib, "pilot"), { recursive: true });
  fs.writeFileSync(path.join(userData, "config.json"), JSON.stringify({ serverUrl: saved, libraryDir: lib, desktopShortcuts: false, token: "smoke-secret-token", user: "sam" }));
  const game = { slug: "pilot", gameId: 1, packageId: 1, name: "Pilot Wings", version: "1.0", path: path.join(lib, "pilot"), launch: { exe: "Pilot.exe", args: "", cwd: "" }, kind: "native", platform: null, sizeBytes: 1, installedAt: 1, serverUrl: saved };
  const rom = { ...game, slug: "dump", name: "A Console Dump", kind: "rom", platform: "ps5", path: path.join(lib, "dump") };
  fs.writeFileSync(path.join(userData, "installed.json"), JSON.stringify([game, rom]));
  require(path.join(root, "dist", "main.cjs"));
  await app.whenReady();
  const win = await until(() => BrowserWindow.getAllWindows()[0], 10_000);
  if (win.isVisible()) throw new Error("the window is on screen");
  const url = () => win.webContents.getURL();
  const js = code => win.webContents.executeJavaScript(code, true);
  const call = code => js(`(async () => { try { return { v: await (${code}) }; } catch (e) { return { e: String(e && e.message || e) }; } })()`);
  /** the first page the window settles on */
  const first = () => until(() => (url() && !url().startsWith("about:") && !win.webContents.isLoading() ? url() : null), 20_000);
  const bridge = () => until(() => js(`typeof window.ahoyLauncher === "object"`), 5_000);
  const text = id => js(`document.getElementById(${JSON.stringify(id)}).textContent`);
  return { win, url, js, call, first, bridge, text };
}

/** the setup page with a server that does not answer: it reaches the launcher, lists the games on this PC, and Play works */
async function setupPage(h) {
  const { url, js, call, text } = h;
  await until(() => url().includes("setup.html"), 15_000);
  ok("a saved server that does not answer: the setup page");
  const c = await call(`ahoyLauncher.config()`);
  if (c.v?.libraryDir !== lib) throw new Error(`the setup page asking the launcher for its settings: ${JSON.stringify(c)}`);
  const rows = await until(() => js(`(() => { const r = [...document.querySelectorAll("#games li")].map(li => li.querySelector("span").textContent + ":" + li.querySelector("button").textContent); return r.length ? r : null; })()`), 10_000);
  if (rows.join("|") !== "Pilot Wings:Play") throw new Error(`the list shows ${rows.join("|")}`);
  if (await js(`getComputedStyle(document.getElementById("here")).display === "none"`)) throw new Error("the list is hidden");
  ok("the games on this PC are listed with Play (a console dump is not)", rows.join(", "));
  await js(`document.querySelector("#games button").click()`);
  const note = await until(() => text("note"), 15_000);
  if (!/missing executable/.test(note)) throw new Error(`Play said: ${note}`);
  ok("Play reaches the launcher from the setup page", note);
}

/* ─────────── the walk ─────────── */

async function walk() {
  const mode = {}, seen = [];
  const other = serve("other");
  const otherPort = await listen(other);
  const port = await freePort();                               // the saved server: a port that answers nothing yet
  const SERVER = `http://127.0.0.1:${port}`, OTHER = `http://127.0.0.1:${otherPort}`;
  const h = await start(SERVER);
  const { win, url, js, call, bridge } = h;

  await setupPage(h);
  // a window that never shows is not always painted: the picture is a convenience, not a step
  if (process.env.SMOKE_SHOT) { try { win.webContents.invalidate(); await sleep(400); fs.writeFileSync(process.env.SMOKE_SHOT, (await win.webContents.capturePage()).toPNG()); ok("picture saved", process.env.SMOKE_SHOT); } catch (e) { console.log(`   no picture: ${e && e.message}`); } }

  // twenty games on this PC: the list scrolls in the room it has; what Play said, the status line and Connect stay below it, in view
  await js(`games = Array.from({ length: 20 }, (_, i) => ({ slug: "g" + i, name: "Game " + (i + 1), kind: "native" })); list(); true`);
  const sizes = [];
  for (const [w, hgt] of [[1360, 860], [980, 640]]) {
    win.setSize(w, hgt);
    // (a pixel or two off on a scaled display)
    await until(() => js(`Math.abs(innerHeight - ${hgt}) <= 8 && Math.abs(innerWidth - ${w}) <= 8`), 5_000).catch(async () => { throw new Error(`the window did not take ${w}×${hgt}: ${JSON.stringify(await js(`[innerWidth, innerHeight]`))}`); });
    await sleep(200);
    const m = await js(`(() => { const b = e => e.getBoundingClientRect(), id = x => document.getElementById(x), u = id("games"); return { h: innerHeight, list: Math.round(b(u).bottom), note: Math.round(b(id("note")).bottom), here: Math.round(b(id("here")).bottom), foot: Math.round(b(document.querySelector(".foot")).top), go: Math.round(b(id("go")).bottom), rows: u.children.length, scrolls: u.scrollHeight > u.clientHeight }; })()`);
    if (m.rows !== 20 || !m.scrolls || m.list > m.note || m.note > m.here || m.here > m.foot + 1 || m.go > m.h) throw new Error(`twenty games at ${w}×${hgt}: ${JSON.stringify(m)}`);
    sizes.push(`${w}×${hgt}: list to ${m.list}, foot from ${m.foot}, Connect to ${m.go} of ${m.h}`);
  }
  win.setSize(1360, 860);
  await js(`(async () => { games = playable(await L.installed()); list(); return true; })()`);
  ok("twenty games: the list keeps to its own room, Connect and the status line stay in view", sizes.join("; "));

  if (diskText().includes("smoke-secret-token") || !disk().tokenSealed) throw new Error("the session is on disk in the clear");
  ok("a session saved in the clear by an older launcher is sealed at the first start");

  // the server comes back: the page finds it and the window returns to it, signed in as before
  const server = serve("ahoy", mode, seen);
  await listen(server, port);
  await until(() => url().startsWith(SERVER + "/"), 40_000);
  await bridge();
  const s1 = await call(`ahoyLauncher.session()`);
  if (s1.v?.token !== "smoke-secret-token" || s1.v?.user !== "sam") throw new Error(`session after coming back: ${JSON.stringify(s1)}`);
  ok("the server answers again: the window goes back to it by itself, still signed in");

  // what a page may put into the settings
  await call(`ahoyLauncher.setSession({ token: "second-secret", user: "sam" })`);
  if (diskText().includes("second-secret")) throw new Error("the session is on disk in the clear");
  if ((await call(`ahoyLauncher.session()`)).v?.token !== "second-secret") throw new Error("the session did not come back");
  if (fs.readdirSync(userData).some(f => /^config\.json\..*tmp$/.test(f))) throw new Error("a temporary settings file was left");
  ok("the session goes to disk sealed, through a file of its own");
  const before = disk();
  for (const bad of [`{ libraryDir: 42 }`, `{ libraryDir: "relative" }`, `{ serverUrl: 7 }`, `{ serverUrl: "file:///C:/x" }`, `{ desktopShortcuts: "yes" }`, `{ libraryDir: ${JSON.stringify(path.join(tmp, "never-picked"))} }`]) {
    const r = await call(`ahoyLauncher.setConfig(${bad})`);
    if (r.v?.ok !== false) throw new Error(`setConfig(${bad}) → ${JSON.stringify(r)}`);
  }
  const r1 = await call(`ahoyLauncher.setConfig({ token: "stolen", user: "admin", junk: 1, desktopShortcuts: true })`);
  const after = disk();
  if (!r1.v?.ok || after.desktopShortcuts !== true || after.junk !== undefined || after.token !== undefined || after.user !== "sam" || after.libraryDir !== before.libraryDir) throw new Error(`after a patch with extra keys: ${JSON.stringify(after)}`);
  if ((await call(`ahoyLauncher.session()`)).v?.token !== "second-secret") throw new Error("a settings patch changed the session");
  ok("a page sets only the three settings, each of its own kind; a folder nobody picked is refused");

  // another server, asked for by the page: the launcher asks the person (here: no)
  const stayed = async what => { await sleep(500); if (!url().startsWith(SERVER + "/") || disk().serverUrl !== SERVER || !disk().tokenSealed) throw new Error(`${what}: the window is on ${url()}, the saved server is ${disk().serverUrl}`); };
  const r2 = await call(`ahoyLauncher.setConfig({ serverUrl: ${JSON.stringify(OTHER)} })`);
  if (r2.v?.ok !== false || asked.length !== 1 || !String(asked[0].detail).includes(OTHER)) throw new Error(`another server: ${JSON.stringify(r2)}, asked ${asked.length}`);
  await stayed("the server changed without a yes");
  ok("a page asking for another server gets the launcher's own question, and no means no");

  // the server's own address starts sending on to another server, and the page asks for "its" server: that is another
  // server too, asked about once, by the address it ends at
  asked.length = 0; mode.sendsTo = OTHER;
  const r3 = await call(`ahoyLauncher.setConfig({ serverUrl: ${JSON.stringify(SERVER)} })`);
  if (r3.v?.ok !== false || asked.length !== 1 || !String(asked[0].detail).includes(OTHER)) throw new Error(`its own address sending on: ${JSON.stringify(r3)}, asked ${asked.length} (${asked[0]?.detail})`);
  await stayed("an address that sends on was followed without a yes");
  mode.sendsTo = null;
  ok("the server's own address sending on to another server is not followed from its page: one question, naming where it ends");

  // the window stays on the server: a look-alike address, and a redirect off the server
  const lookalike = `http://127.0.0.1:${port}@127.0.0.1:${otherPort}/`;
  await js(`location.href = ${JSON.stringify(lookalike)}; true`);
  await sleep(1200);
  if (!url().startsWith(SERVER + "/")) throw new Error(`the window went to ${url()}`);
  if (!opened.some(u => u.includes(`:${otherPort}`))) throw new Error("the look-alike address was not handed to the browser");
  ok("a look-alike address does not get the window");
  opened.length = 0;
  await js(`location.href = ${JSON.stringify(`${SERVER}/away?to=${encodeURIComponent(OTHER + "/")}`)}; true`);
  await sleep(1200);
  if (new URL(url()).origin !== SERVER) throw new Error(`a redirect took the window to ${url()}`);
  ok("a redirect off the server does not get the window");

  // only http(s) leaves for the browser
  opened.length = 0;
  await js(`for (const u of ["file:///C:/Windows/System32/calc.exe", "search-ms:query=x", "ms-settings:display", "https://example.invalid/page"]) window.open(u); true`);
  await sleep(800);
  if (opened.join("|") !== "https://example.invalid/page") throw new Error(`handed to the system: ${opened.join("|")}`);
  await js(`location.href = "ms-settings:display"; true`);
  await sleep(500);
  if (opened.length !== 1) throw new Error(`a navigation handed over: ${opened.join("|")}`);
  ok("only http and https links are handed to the system browser");

  // a page that is not the server's has the bridge object, and nothing behind it
  await win.loadURL(OTHER + "/");
  await bridge();
  for (const c of [`ahoyLauncher.session()`, `ahoyLauncher.config()`, `ahoyLauncher.setConfig({ serverUrl: "" })`, `ahoyLauncher.play("pilot")`, `ahoyLauncher.installed()`, `ahoyLauncher.install(1)`]) {
    const r = await call(c);
    if (!r.e || !/not available on this page/.test(r.e)) throw new Error(`${c} from another site → ${JSON.stringify(r)}`);
  }
  if (disk().serverUrl !== SERVER) throw new Error("another site changed the server");
  ok("a page that is not the server's cannot use the bridge");

  // yes to the question: the launcher goes to the address the question showed (where the asked one ended), signed out
  await win.loadURL(SERVER + "/");
  await bridge();
  asked.length = 0; answer = 1; mode.sendsTo = OTHER;
  const r4 = await call(`ahoyLauncher.setConfig({ serverUrl: ${JSON.stringify(SERVER)} })`);
  await until(() => url().startsWith(OTHER + "/"), 15_000);
  const moved = disk();
  if (!r4.v?.ok || asked.length !== 1 || !String(asked[0].detail).startsWith(OTHER + "\n") || moved.serverUrl !== OTHER || moved.tokenSealed || moved.token || moved.user) throw new Error(`after a yes: ${JSON.stringify(r4)}, asked ${asked.map(a => a.detail).join(" | ")}, saved ${JSON.stringify(moved)}`);
  ok("yes to the question connects to exactly the address it showed, signed out of the old server");

  server.close(); other.close();
}

/* ─────────── starts of their own ─────────── */

/** a saved address spelled with capital letters (fetch and the window report it in small ones): the same server */
async function spelling() {
  const seen = [];
  const server = serve("ahoy", {}, seen);
  const port = await listen(server);
  const SAVED = `http://LOCALHOST:${port}`, PLAIN = `http://localhost:${port}`;
  const { url, call, first, bridge } = await start(SAVED);
  const at = await first();
  if (!at.startsWith(PLAIN + "/")) throw new Error(`the first page is ${at.includes("setup.html") ? "the setup page" : at}`);
  await bridge();
  const s = await call(`ahoyLauncher.session()`);
  if (s.v?.token !== "smoke-secret-token" || s.v?.user !== "sam") throw new Error(`the session: ${JSON.stringify(s)}`);
  if (disk().serverUrl !== SAVED || !disk().tokenSealed) throw new Error(`the settings were rewritten: ${diskText()}`);
  ok("a saved address in another spelling is the same server: its page at once, still signed in, saved as it was");
  // its games are still this server's: Play asks it how the game starts
  seen.length = 0;
  await call(`ahoyLauncher.play("pilot")`);
  if (!seen.includes("GET /api/v1/package/1/launch")) throw new Error(`Play did not ask the server how the game starts (asked: ${seen.join(", ") || "nothing"})`);
  ok("the games installed from it are still its own: Play asks the server how the game starts");
  // the page naming it in the other spelling is not asking for another server
  const r = await call(`ahoyLauncher.setConfig({ serverUrl: ${JSON.stringify(PLAIN + "/")} })`);
  await sleep(400);
  if (!r.v?.ok || asked.length || disk().serverUrl !== SAVED || !disk().tokenSealed || !url().startsWith(PLAIN + "/")) throw new Error(`the same server named in small letters: ${JSON.stringify(r)}, asked ${asked.length}, saved ${diskText()}`);
  ok("its page naming it in the other spelling changes nothing and asks nothing");
  server.close();
}

/** the saved server's address sends on to another server: nothing follows it by itself; Connect for the other address does */
async function sentOn() {
  const modeA = {}, seenB = [];
  const a = serve("ahoy", modeA), b = serve("other", {}, seenB);
  const A = `http://127.0.0.1:${await listen(a)}`, B = `http://127.0.0.1:${await listen(b)}`;
  modeA.sendsTo = B;
  const { url, js, call, first, bridge, text } = await start(A);
  const at = await first();
  if (!at.includes("setup.html")) throw new Error(`the first page is ${at}`);
  await until(async () => (await text("msg")).includes(`sends on to ${B}`), 10_000);
  ok("a saved server that sends on to another address: the setup page, saying where it leads", await text("msg"));
  // the page looks for the saved server again every 15 s: past that, nobody touching anything
  await sleep(18_000);
  if (!url().includes("setup.html") || disk().serverUrl !== A || !disk().tokenSealed || asked.length || seenB.some(x => !x.endsWith("/api/health"))) throw new Error(`left alone: the window is on ${url()}, saved ${diskText()}, asked ${asked.length}, the other server saw ${seenB.join(", ")}`);
  ok("left alone, the launcher stays where it is: not moved, not saved, the other server never shown");
  // Connect with the saved address: the other address is put into the field, nothing more
  await js(`document.getElementById("go").click()`);
  await until(() => js(`document.getElementById("server").value === ${JSON.stringify(B)}`), 10_000);
  await sleep(400);
  if (!url().includes("setup.html") || disk().serverUrl !== A || !/sends on to this one/.test(await text("msg"))) throw new Error(`after Connect: ${url()}, saved ${disk().serverUrl}, status ${await text("msg")}`);
  ok("Connect shows the address it leads to and waits", await text("msg"));
  // Connect for that address: the person's own choice of another server
  await js(`document.getElementById("go").click()`);
  await until(() => url().startsWith(B + "/"), 15_000);
  await bridge();
  const d = disk();
  if (d.serverUrl !== B || d.tokenSealed || d.token || d.user || (await call(`ahoyLauncher.session()`)).v !== null) throw new Error(`after connecting to it: ${JSON.stringify(d)}`);
  ok("Connect for that address goes there, signed out of the old server");
  a.close(); b.close();
}

/** openssl, on the PATH or where Git for Windows keeps its own */
function openssl() {
  const git = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")].filter(Boolean).map(d => path.join(d, "Git"));
  for (const exe of ["openssl", ...git.flatMap(g => [path.join(g, "mingw64", "bin", "openssl.exe"), path.join(g, "usr", "bin", "openssl.exe")])]) {
    try { if (spawnSync(exe, ["version"], { windowsHide: true, stdio: "ignore" }).status === 0) return exe; } catch { /* the next one */ }
  }
  return null;
}

/** the saved http address now answers from https (the same host): kept by the https one, session and games with it */
async function upgraded() {
  const exe = openssl();
  if (!exe) { console.log("SKIPPED the https case — no openssl on this PC to make its certificate"); return; }
  const key = path.join(tmp, "key.pem"), cert = path.join(tmp, "cert.pem");
  const made = spawnSync(exe, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { windowsHide: true, stdio: "ignore", env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" } });
  if (made.status !== 0 || !fs.existsSync(cert)) { console.log("SKIPPED the https case — openssl made no certificate"); return; }
  const seen = [];
  const secure = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, answers("ahoy", {}, seen));
  const ps = await listen(secure);
  const HTTPS = `https://127.0.0.1:${ps}`;
  const plain = serve("ahoy", { sendsTo: HTTPS });
  const pp = await listen(plain);
  const HTTP = `http://127.0.0.1:${pp}`;
  const { call, first, bridge } = await start(HTTP);
  const at = await first();
  if (!at.startsWith(HTTPS + "/")) throw new Error(`the first page is ${at.includes("setup.html") ? "the setup page" : at}`);
  await bridge();
  const s = await call(`ahoyLauncher.session()`);
  if (s.v?.token !== "smoke-secret-token" || disk().serverUrl !== HTTPS || !disk().tokenSealed) throw new Error(`session ${JSON.stringify(s)}, saved ${diskText()}`);
  ok("a server answering its http address from https is kept by the https one, still signed in", `${HTTP} → ${HTTPS}`);
  const recorded = installed().map(g => g.serverUrl);
  if (recorded.some(u => u !== HTTPS)) throw new Error(`the games are recorded under ${recorded.join(", ")}`);
  seen.length = 0;
  await call(`ahoyLauncher.play("pilot")`);
  if (!seen.includes("GET /api/v1/package/1/launch")) throw new Error(`Play did not ask the server how the game starts (asked: ${seen.join(", ") || "nothing"})`);
  ok("the games installed from it went with it: recorded under the https address, and Play asks the server how the game starts");
  secure.close(); plain.close();
}

/** what 0.12 adds for the big screen: the page's zoom, the wish for the big screen from outside the page, the pad's home button */
async function big() {
  const server = serve("ahoy");
  const port = await listen(server);
  const SERVER = `http://localhost:${port}`;
  process.argv.push("--big");
  const { win, js, call, first, bridge } = await start(SERVER);
  await first(); await bridge();
  const feats = await js(`ahoyLauncher.features`);
  for (const f of ["zoom", "big", "pad-button"]) if (!feats.includes(f)) throw new Error(`the bridge does not say "${f}": ${feats}`);
  // started with --big: the page is told once, when it asks
  const w1 = await call(`ahoyLauncher.wantsBig()`), w2 = await call(`ahoyLauncher.wantsBig()`);
  if (w1.v !== true || w2.v !== false) throw new Error(`--big: ${JSON.stringify([w1, w2])}`);
  ok("started with --big, the page is told so once");

  // the page's zoom: the browser's own (the page lays itself out for the smaller window), between 1 and 4
  const w0 = await js(`innerWidth`);
  const z = await call(`ahoyLauncher.zoom(1.5)`);
  await sleep(300);
  const wz = await js(`innerWidth`);
  if (z.v !== 1.5 || Math.abs(win.webContents.getZoomFactor() - 1.5) > 0.01 || Math.abs(w0 / wz - 1.5) > 0.05) throw new Error(`zoom 1.5: ${JSON.stringify(z)}, factor ${win.webContents.getZoomFactor()}, width ${w0} -> ${wz}`);
  const far = await call(`ahoyLauncher.zoom(9)`), odd = await call(`ahoyLauncher.zoom("big")`), back = await call(`ahoyLauncher.zoom(0)`);
  if (far.v !== 4 || odd.v !== 1 || back.v !== 1 || Math.abs(win.webContents.getZoomFactor() - 1) > 0.01) throw new Error(`zoom bounds: ${JSON.stringify([far, odd, back])}`);
  ok("the page zooms itself: the window is laid out smaller, never past 4, never under 1", `${w0} px wide, ${wz} at 1.5`);

  // the pad's home button: nothing listens until the setting wants it
  const padWin = () => BrowserWindow.getAllWindows().find(x => x !== win);
  const cfg0 = await call(`ahoyLauncher.config()`);
  if (cfg0.v?.padButton !== "off" || padWin()) throw new Error(`before the setting: ${JSON.stringify(cfg0.v?.padButton)}, windows ${BrowserWindow.getAllWindows().length}`);
  for (const bad of [`"always"`, `true`, `null`]) { const r = await call(`ahoyLauncher.setConfig({ padButton: ${bad} })`); if (r.v?.ok !== false) throw new Error(`padButton ${bad} was taken: ${JSON.stringify(r)}`); }
  const on = await call(`ahoyLauncher.setConfig({ padButton: "big" })`);
  const pw = await until(() => padWin(), 5000);
  await until(() => !pw.webContents.isLoading() && pw.webContents.getURL().endsWith("pad.html"), 5000);
  if (!on.v?.ok || disk().padButton !== "big" || pw.isVisible() || win.isVisible()) throw new Error(`the setting on: ${JSON.stringify(on)}, saved ${disk().padButton}, shown ${pw.isVisible()}`);
  const seesPads = await pw.webContents.executeJavaScript(`[document.visibilityState, typeof navigator.getGamepads]`, true);
  if (seesPads[0] !== "visible" || seesPads[1] !== "function") throw new Error(`the watcher's page: ${seesPads}`);
  ok("with the setting on, a window that is never shown watches the pads", `its page counts as ${seesPads[0]}`);

  // a pad of the test's own, put where the watcher looks (its preload's own world)
  const world = code => pw.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }], true);
  await world(`window.__pads = []; navigator.getGamepads = () => window.__pads; 1`);
  const padDown = buttons => world(`window.__pads = [{ mapping: "standard", buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: ${JSON.stringify(buttons)}.includes(i) })) }]; 1`);
  await js(`window.__got = []; ahoyLauncher.onEvent(e => { if (e && e.type === "big") window.__got.push(e); }); 1`);
  await padDown([0]); await sleep(300);                                   // A is not the home button
  await padDown([16]); await sleep(600);                                  // held for more than half a second: one press
  await padDown([]); await sleep(200);
  let got = await js(`window.__got`);
  const t1 = await call(`ahoyLauncher.wantsBig()`), t2 = await call(`ahoyLauncher.wantsBig()`);
  if (got.length !== 1 || got[0].on !== true || t1.v !== true || t2.v !== false) throw new Error(`one press of the home button: ${JSON.stringify(got)}, wish ${JSON.stringify([t1, t2])}`);
  await padDown([16]); await sleep(250); await padDown([]); await sleep(200);
  got = await js(`window.__got`);
  if (got.length !== 2) throw new Error(`a second press: ${JSON.stringify(got)}`);
  await call(`ahoyLauncher.wantsBig()`);
  if (win.isVisible()) throw new Error("the window came on screen in a run that keeps it off");
  ok("the home button, pressed once however long it is held, asks the page for the big screen; another button does not");

  // "show" only brings the window to the front: the page is asked for nothing
  await call(`ahoyLauncher.setConfig({ padButton: "show" })`);
  await padDown([16]); await sleep(300); await padDown([]); await sleep(200);
  const t3 = await call(`ahoyLauncher.wantsBig()`);
  if ((await js(`window.__got`)).length !== 2 || t3.v !== false || !padWin()) throw new Error(`set to show: ${JSON.stringify(await js(`window.__got`))}, wish ${JSON.stringify(t3)}`);
  ok("set to show the launcher only, the button asks the page for nothing");

  // off again: nothing watches
  await call(`ahoyLauncher.setConfig({ padButton: "off" })`);
  await until(() => !padWin(), 5000);
  if (disk().padButton !== "off") throw new Error(`saved: ${diskText()}`);
  ok("with the setting off again, nothing watches the pads");
  server.close();
}

/** what 0.13 adds: the drive's room, notifications, running without its window, saves in step with the server */
async function away() {
  // a server that also keeps versions of saves, as the real one does on the wire
  const kept = [], seenAuth = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    const json = (body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    const m = /^\/api\/v1\/saves\/(g1)(?:\/(\d+))?$/.exec(u.pathname);
    if (m && req.method === "POST") {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => {
        seenAuth.push(req.headers.authorization);
        const meta = JSON.parse(decodeURIComponent(req.headers["x-ahoy-save"]));
        // one part is the whole of it here (the saves are a few bytes): "<upload>:0:1"
        if (!/^[a-z0-9]{8,40}:0:1$/.test(String(req.headers["x-ahoy-part"]))) return json({ error: "not a part" }, 400);
        kept.push({ id: kept.length + 1, meta, body: Buffer.concat(chunks) });
        json({ item: { id: kept.length, digest: meta.digest }, same: false }, 201);
      });
      return;
    }
    if (m && req.method === "GET" && m[2]) { const v = kept.find(x => x.id === Number(m[2])); if (!v) return json({ error: "no such saves" }, 404); res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(v.body); }
    return answers("ahoy", {}, [])(req, res);
  });
  const port = await listen(server);
  const SERVER = `http://localhost:${port}`;
  const { win, js, call, first, bridge } = await start(SERVER);
  await first(); await bridge();
  const feats = await js(`ahoyLauncher.features`);
  for (const f of ["notify", "disk", "background", "saves"]) if (!feats.includes(f)) throw new Error(`the bridge does not say "${f}": ${feats}`);

  const d = await call(`ahoyLauncher.disk()`);
  if (!(d.v && d.v.free > 0 && d.v.total >= d.v.free)) throw new Error(`disk: ${JSON.stringify(d)}`);
  ok("the room on the drive games go to", `${Math.round(d.v.free / 1e9)} GB free of ${Math.round(d.v.total / 1e9)}`);

  // a notification: kept here instead of shown; clicked, the page is told which of its pages to open
  const notes = globalThis.ahoyNotes;
  if (!Array.isArray(notes)) throw new Error("an automated run keeps no list of notifications");
  await js(`window.__open = []; ahoyLauncher.onEvent(e => { if (e && e.type === "open") window.__open.push(e.route); }); 1`);
  const n1 = await call(`ahoyLauncher.notify({ title: "Pilot Wings is ready to play", body: "x", route: "/game/1" })`);
  const n2 = await call(`ahoyLauncher.notify({ title: "Elsewhere", route: "https://evil.example/" })`);
  const n3 = await call(`ahoyLauncher.notify({ body: "no title" })`);
  if (n1.v !== true || n2.v !== true || n3.v !== false || notes.length !== 2) throw new Error(`notify: ${JSON.stringify([n1, n2, n3])}, kept ${notes.length}`);
  if (notes[0].title !== "Pilot Wings is ready to play" || notes[0].route !== "/game/1" || notes[1].route !== null) throw new Error(`what was kept: ${JSON.stringify(notes.map(n => [n.title, n.route]))}`);
  notes[0].click(); notes[1].click();
  await sleep(300);
  const opened2 = await js(`window.__open`);
  if (JSON.stringify(opened2) !== JSON.stringify(["/game/1"]) || win.isVisible()) throw new Error(`clicked: ${JSON.stringify(opened2)}, on screen ${win.isVisible()}`);
  ok("a notification while the window is not in front; clicked, it opens its page of the app, and no other address");

  // without its window: on by default, closing hides; the three settings are kept, each a yes or a no
  const cfg0 = (await call(`ahoyLauncher.config()`)).v;
  if (cfg0.background !== true || cfg0.startWithWindows !== false || cfg0.syncSaves !== true) throw new Error(`the settings to begin with: ${JSON.stringify(cfg0)}`);
  for (const bad of [`{ background: "yes" }`, `{ startWithWindows: 1 }`, `{ syncSaves: null }`]) { const r = await call(`ahoyLauncher.setConfig(${bad})`); if (r.v?.ok !== false) throw new Error(`${bad} was taken`); }
  win.close();
  await sleep(400);
  if (win.isDestroyed() || BrowserWindow.getAllWindows().length !== 1) throw new Error("closing the window ended it, with the setting on");
  const w2 = await call(`ahoyLauncher.setConfig({ startWithWindows: true })`);
  if (!w2.v?.ok || disk().startWithWindows !== true || disk().background !== true) throw new Error(`saved: ${diskText()}`);
  ok("closed, Ahoy stays (the setting is on by default); starting with Windows is a setting it keeps");

  // saves: found by the rules, brought to the server, put back from it
  const saveDir = path.join(lib, "pilot", "saves");
  fs.mkdirSync(saveDir, { recursive: true });
  fs.writeFileSync(path.join(saveDir, "slot1.sav"), "an evening's progress");
  fs.writeFileSync(path.join(saveDir, "tool.exe"), "not a save");
  const rules = `{ paths: ["<base>/saves"], exclude: [], made: false }`;
  const s1 = (await call(`ahoyLauncher.saves.state("pilot", "g1", ${rules})`)).v;
  if (!s1 || s1.files !== 1 || !/^[0-9a-f]{64}$/.test(s1.digest) || s1.base !== null || s1.where[0] !== "<base>/saves") throw new Error(`state: ${JSON.stringify(s1)}`);
  const p1 = await call(`ahoyLauncher.saves.push("pilot", "g1", ${rules})`);
  if (!p1.v || p1.v.id !== 1 || p1.v.digest !== s1.digest || kept.length !== 1 || seenAuth[0] !== "Bearer smoke-secret-token") throw new Error(`push: ${JSON.stringify(p1)}, kept ${kept.length}`);
  if (kept[0].meta.files !== 1 || kept[0].meta.name !== "Pilot Wings" || kept[0].body.subarray(-8).toString() !== "AHOYSAV1") throw new Error(`what the server got: ${JSON.stringify(kept[0].meta)}`);
  ok("a game's saves are found by the rules and brought to the server with the launcher's own session", `${kept[0].body.length} bytes for ${kept[0].meta.files} file`);
  fs.writeFileSync(path.join(saveDir, "slot1.sav"), "overwritten here");
  const g1 = await call(`ahoyLauncher.saves.pull("pilot", "g1", ${rules}, 1)`);
  const back = fs.readFileSync(path.join(saveDir, "slot1.sav"), "utf8");
  const backups = path.join(userData, "save-backups", "g1");
  const stamp = fs.existsSync(backups) ? fs.readdirSync(backups)[0] : null;
  if (g1.v?.written !== 1 || back !== "an evening's progress" || !stamp || fs.readFileSync(path.join(backups, stamp, "base", "saves", "slot1.sav"), "utf8") !== "overwritten here") throw new Error(`pull: ${JSON.stringify(g1)}, file "${back}", backup ${stamp}`);
  const s2 = (await call(`ahoyLauncher.saves.state("pilot", "g1", ${rules})`)).v;
  if (s2.digest !== s1.digest || s2.base?.id !== 1) throw new Error(`after the pull: ${JSON.stringify(s2)}`);
  ok("a version from the server is put back; what it replaced is copied aside first");
  // a path out of the game's folder is no rule: nothing is found there
  const out = (await call(`ahoyLauncher.saves.state("pilot", "g1", { paths: ["<base>/../../", "C:/Windows", "<home>"], exclude: [], made: false })`)).v;
  if (!out || out.files !== 0) throw new Error(`rules that leave their place found: ${JSON.stringify(out)}`);
  const rom = await call(`ahoyLauncher.saves.state("dump", "g1", ${rules})`), none = await call(`ahoyLauncher.saves.state("nope", "g1", ${rules})`), badKey = await call(`ahoyLauncher.saves.state("pilot", "../x", ${rules})`);
  if (!rom.e || !none.e || !badKey.e) throw new Error(`a console dump, a game that is not here, a key that is none: ${JSON.stringify([rom, none, badKey])}`);
  await call(`ahoyLauncher.setConfig({ syncSaves: false })`);
  const off1 = await call(`ahoyLauncher.saves.push("pilot", "g1", ${rules})`), off2 = await call(`ahoyLauncher.saves.pull("pilot", "g1", ${rules}, 1)`);
  if (!off1.e || !off2.e || kept.length !== 1) throw new Error(`with the setting off: ${JSON.stringify([off1, off2])}`);
  ok("nothing is found outside the places a rule may name; nothing moves with the setting off, for a console dump, or for a game that is not here");
  server.close();
}

/** this file again, as a start of its own; its steps are printed under the case's name */
const again = (name, env = {}) => new Promise(res => {
  const c = spawn(process.execPath, [__filename], { env: { ...process.env, SMOKE_CASE: name, SMOKE_SHOT: "", ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let out = "";
  c.stdout.on("data", d => { out += d; }); c.stderr.on("data", d => { out += d; });
  c.on("error", e => res({ code: 1, lines: [`FAIL — could not start: ${e.message}`] }));
  c.on("exit", code => res({ code, lines: out.split(/\r?\n/).filter(l => /^(OK|FAIL|SKIPPED) /.test(l)) }));
});

const cases = { walk, spelling, "sent-on": sentOn, "setup-page": async () => setupPage(await start(`http://127.0.0.1:${await freePort()}`)), https: upgraded, big, away };

(async () => {
  try {
    if (!cases[CASE]) throw new Error(`no such case: ${CASE}`);
    await cases[CASE]();
    if (CASE === "walk") {
      // a copy of the app in a folder with a % (and a space, an accent) in its name, for the setup page's own start
      const odd = path.join(tmp, "pct 100% fün");
      for (const d of ["dist", "assets"]) fs.cpSync(path.join(root, d), path.join(odd, d), { recursive: true });
      fs.copyFileSync(path.join(root, "package.json"), path.join(odd, "package.json"));
      for (const [name, env] of [["spelling", {}], ["sent-on", {}], ["setup-page", { SMOKE_ROOT: odd }], ["https", {}], ["big", {}], ["away", {}]]) {
        const r = await again(name, env);
        for (const l of r.lines) { steps.push(`   [${name}] ${l}`); console.log(steps.at(-1)); }
        if (r.code !== 0) throw new Error(`the ${name} case failed`);
      }
    }
    if (CASE === "walk") console.log("\nALL STEPS PASSED");
    cleanup(); app.exit(0);
  } catch (e) {
    console.log(`FAIL — ${e && e.message} (url: ${BrowserWindow.getAllWindows()[0]?.webContents.getURL()})`);
    if (CASE === "walk") console.log(steps.join("\n"));
    cleanup(); app.exit(1);
  }
})();
