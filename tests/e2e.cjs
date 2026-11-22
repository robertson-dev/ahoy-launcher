/**
 * Ahoy launcher — end-to-end drive of the real app against a real Ahoy server.
 *
 *   SERVER=http://<ahoy server>:8790 AHOY_USER=... AHOY_PASS=... GAME=7 node_modules/.bin/electron tests/e2e.cjs
 *
 * Runs the bundled main process with a throwaway userData, walks the first-run setup, signs in on the server's
 * own gate (AHOY_USER / AHOY_PASS; with E2E_SIGNUP=1 it creates that account instead), installs the game into a
 * temp folder through the page's own buttons, launches it (only with E2E_PLAY=1), uninstalls. Desktop shortcuts
 * are switched off for the run. Exit code 0 only when every step passed. The window is hidden.
 * It reads both web UIs: the one before the 2026-11 redesign (form.auth, nav.tabs, .people-line) and the redesigned one
 * (form.au-form, nav.tb-nav, the game page's "Installed by" fact); both mark the game page's main action with data-primary.
 */
const { app, BrowserWindow } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SERVER = (process.env.SERVER || "").replace(/\/+$/, "");
if (!SERVER) { console.log("FAIL set SERVER to an Ahoy server (http://host:8790)"); process.exit(1); }
const GAME = process.env.GAME || "7";                        // /game/<id>
const USER = process.env.AHOY_USER || "", PASS = process.env.AHOY_PASS || "";
const root = path.resolve(__dirname, "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ahoy-e2e-userdata-"));
const libraryDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahoy-e2e-library-"));
app.setPath("userData", userData);
app.setAppPath(root);                                        // launched via this file, so point the app root back at launcher/
process.env.ELECTRON_ENABLE_LOGGING = "0";
if (!process.env.E2E_SHOW) process.env.AHOY_HIDDEN = "1";      // the window is made hidden, so it never flashes up

const steps = [];
const ok = (name, detail = "") => { steps.push(`OK ${name}${detail ? " — " + detail : ""}`); console.log(steps.at(-1)); };
const fail = (name, detail) => { console.log(`FAIL ${name} — ${detail}`); console.log(steps.join("\n")); app.exit(1); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms, every = 500) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error("timeout"); await sleep(every); } };

require(path.join(root, "dist", "main.cjs"));

app.whenReady().then(async () => {
  try {
    if (!USER || !PASS) throw new Error("set AHOY_USER and AHOY_PASS (an account on the server; E2E_SIGNUP=1 creates it)");
    const win = await until(() => BrowserWindow.getAllWindows()[0], 10_000);
    win.setTitle("Ahoy — automated test (ignore)");
    if (!process.env.E2E_SHOW) win.hide();                   // a visible test window invites clicks from a real person
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await until(() => win.webContents.getURL().includes("setup.html"), 10_000);
    ok("first run shows the setup page");
    await until(() => js(`typeof window.ahoyLauncher === "object"`), 5_000);
    ok("bridge present on the setup page");
    await js(`document.getElementById("server").value = ${JSON.stringify(SERVER)}; document.getElementById("dir").value = ${JSON.stringify(libraryDir)}; document.getElementById("go").click();`);
    await until(() => win.webContents.getURL().startsWith(SERVER), 20_000);
    ok("connected: the window navigated to the server", win.webContents.getURL());
    await until(() => js(`typeof window.ahoyLauncher === "object" && !!document.querySelector("form.auth, form.au-form")`), 20_000);
    ok("the server's sign-in gate is up inside the launcher, with the bridge");

    // sign in (or up) through the page's own form
    const setVal = (sel, v) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    if (process.env.E2E_SIGNUP) { await js(`(() => { const b = [...document.querySelectorAll("form.auth button, form.au-form button")].find(b => /Create (one|an account)/.test(b.textContent)); if (b) b.click(); return true; })()`); await sleep(300); }
    await setVal('form.auth input[autocomplete="username"], form.au-form input[autocomplete="username"]', USER);
    await setVal('form.auth input[type="password"], form.au-form input[type="password"]', PASS);
    await js(`document.querySelector("form.auth button.primary, form.au-form button[type=submit]").click()`);
    await until(() => js(`!!document.querySelector("nav.tabs, nav.tb-nav")`), 20_000);
    ok("signed in: the Ahoy UI is up", USER);
    const session = await js(`window.ahoyLauncher.session()`);
    if (!session || !session.token) throw new Error("the launcher did not receive the session token");
    ok("the launcher keeps the session for its own downloads");

    const off = await js(`window.ahoyLauncher.setConfig({ desktopShortcuts: false })`);
    if (!off.ok) throw new Error("could not switch desktop shortcuts off");
    ok("desktop shortcuts off for the test");
    await win.loadURL(`${SERVER}/game/${GAME}`);
    const PRIMARY = `document.querySelector("[data-primary]")`;
    const installBtn = await until(() => js(`(() => { const b = ${PRIMARY}; return b && /Install/.test(b.textContent) ? b.textContent : null; })()`), 30_000);
    ok("game page offers Install", installBtn.trim());
    await js(`${PRIMARY}.click()`);
    const sawProgress = await until(() => js(`/installing|checking files|setting up|finishing/i.test(document.body.innerText) ? document.body.innerText.match(/(installing|checking files|setting up|finishing)[^\\n]*/i)?.[0] : null`), 30_000);
    ok("install progress is shown", sawProgress);
    const installed = await until(async () => (await js(`window.ahoyLauncher.installed()`)).find(g => g.path.startsWith(libraryDir)), 1_200_000, 2000);
    ok("installed", `${installed.name} v${installed.version} → ${installed.path} (${(installed.sizeBytes / 1e9).toFixed(2)} GB)`);
    if (!fs.existsSync(path.join(installed.path, installed.launch.exe))) throw new Error("launch exe missing on disk");
    ok("launch executable on disk", installed.launch.exe);
    await until(() => js(`(() => { const b = ${PRIMARY}; return b && /Play/.test(b.textContent); })()`), 15_000);
    ok("game page shows Play");
    // the server was told: the game page names this PC's owner
    const owners = await until(() => js(`(() => {
      const t = document.querySelector(".people-line")?.textContent ?? "";
      if (/installed/.test(t)) return t;
      const row = [...document.querySelectorAll(".gp-fact")].find(r => /Installed by/.test(r.querySelector("dt")?.textContent ?? ""));
      const who = (row?.querySelector(".gp-ppl-t") ?? row?.querySelector("dd"))?.textContent ?? "";   // the names, not the faces' initials
      return who.split(/[^A-Za-z]+/).includes("You") ? "Installed by " + who : null;
    })()`), 15_000);
    ok("the server knows it is installed here", owners.trim().slice(0, 80));

    if (process.env.E2E_PLAY) {
      const pid = await js(`window.ahoyLauncher.play(${JSON.stringify(installed.slug)})`);
      if (!(pid > 0)) throw new Error("play returned no pid");
      await until(() => js(`/Running/i.test(document.body.innerText)`), 10_000);
      ok("game launched and the UI shows it running", `pid ${pid}`);
      await sleep(6000);
      try { process.kill(pid); } catch { /* may have exited already */ }
      await until(() => js(`!/\bRunning\b/.test(document.body.innerText)`), 15_000);
      ok("game stopped and the UI shows Play again");
    } else ok("launching skipped (set E2E_PLAY=1 to start the game for real)");

    await js(`window.ahoyLauncher.uninstall(${JSON.stringify(installed.slug)})`);
    await until(() => !fs.existsSync(installed.path), 30_000);
    ok("uninstalled; folder removed");
    console.log("\nALL STEPS PASSED");
    app.exit(0);
  } catch (e) {
    const url = BrowserWindow.getAllWindows()[0]?.webContents.getURL();
    fail("step", `${e && e.message} (url: ${url})`);
  } finally {
    try { fs.rmSync(libraryDir, { recursive: true, force: true }); fs.rmSync(userData, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
