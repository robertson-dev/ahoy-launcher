/**
 * Ahoy launcher — the self-updater against a local feed (bun run test:update).
 *
 * Serves release/Ahoy-Setup-<version>.exe behind a latest.yml that claims version 99.0.0, points the updater at it
 * (dev config, since this app is not packaged) and expects: checking → available → downloading → ready, with the
 * installer verified by sha512 in a throwaway cache. A second run against a feed with no latest.yml must settle on
 * "none", not an error. Then what the updater must refuse (the builds are not code-signed, so these checks are what there
 * is): a build whose file sits at another address, a download that does not match the published sha512, and a feed over
 * plain http that is not on this PC's own network. Exit code 0 only when all pass. Nothing is installed.
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

const root = path.resolve(__dirname, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ahoy-update-"));
process.env.LOCALAPPDATA = path.join(tmp, "cache");            // electron-updater's download cache goes under LOCALAPPDATA
fs.mkdirSync(process.env.LOCALAPPDATA, { recursive: true });
const { app } = require("electron");
app.setPath("userData", path.join(tmp, "userData"));
app.setAppPath(root);

const exe = fs.readdirSync(path.join(root, "release")).filter(f => /^Ahoy-Setup-.*\.exe$/.test(f)).sort().at(-1);
if (!exe) { console.log("FAIL no release/Ahoy-Setup-*.exe — run bun run dist first"); process.exit(1); }
const exePath = path.join(root, "release", exe);
const bytes = fs.readFileSync(exePath);
const sha512 = crypto.createHash("sha512").update(bytes).digest("base64");
const latest = `version: 99.0.0\nfiles:\n  - url: ${exe}\n    sha512: ${sha512}\n    size: ${bytes.length}\npath: ${exe}\nsha512: ${sha512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`;

const steps = [];
const ok = (n, d = "") => { steps.push(`OK ${n}${d ? " — " + d : ""}`); console.log(steps.at(-1)); };
const fail = (n, d) => { console.log(`FAIL ${n} — ${d}`); console.log(steps.join("\n")); cleanup(); app.exit(1); };
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp */ } };

let publish = true;
const wrong = crypto.createHash("sha512").update("another file").digest("base64");
const served = [];                                             // every request for the installer
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split("?")[0].split("/").pop());
  // /elsewhere: a build whose file is at another address; /tampered: the right file under a checksum that is not its own
  if (name === "latest.yml" && req.url.startsWith("/elsewhere/")) { res.writeHead(200, { "content-type": "text/yaml" }); return res.end(latest.split(`url: ${exe}`).join(`url: http://127.0.0.2:${server.address().port}/launcher/${exe}`)); }
  if (name === "latest.yml" && req.url.startsWith("/tampered/")) { res.writeHead(200, { "content-type": "text/yaml" }); return res.end(latest.split(sha512).join(wrong)); }
  if (name === exe) served.push(req.url);
  if (name === "latest.yml") { if (!publish) { res.writeHead(404); return res.end("no"); } res.writeHead(200, { "content-type": "text/yaml" }); return res.end(latest); }
  if (name === exe) {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
    if (m) { const a = +m[1], b = m[2] ? +m[2] : bytes.length - 1; res.writeHead(206, { "content-range": `bytes ${a}-${b}/${bytes.length}`, "content-length": b - a + 1, "accept-ranges": "bytes" }); return res.end(bytes.subarray(a, b + 1)); }
    res.writeHead(200, { "content-length": bytes.length, "accept-ranges": "bytes" }); return res.end(bytes);
  }
  res.writeHead(404); res.end("no");
});

app.whenReady().then(async () => {
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const feed = `http://127.0.0.1:${server.address().port}`;
  const devConfig = path.join(tmp, "dev-app-update.yml");
  fs.writeFileSync(devConfig, `provider: generic\nurl: ${feed}/launcher\nupdaterCacheDirName: ahoy-launcher-updater\n`);
  const { Updater } = require(path.join(root, "dist", "updater.cjs"));
  const seen = [];
  const waiters = [];
  // installOnQuit: false — this is a test; nothing may be installed on this PC when it exits
  const u = new Updater(s => { seen.push(s.status); for (const w of waiters.splice(0)) w(s); }, { devConfig, installOnQuit: false, log: l => process.env.E2E_VERBOSE && console.log("   " + l) });
  const next = (pred, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error(`timeout waiting; saw ${seen.join(" → ")}`)), ms); const w = s => { if (pred(s)) { clearTimeout(t); res(s); } else waiters.push(w); }; waiters.push(w); });
  try {
    ok("app version", app.getVersion());
    u.follow(feed);
    if (!u.enabled()) throw new Error("updater says it is disabled");
    const ready = next(s => s.status === "ready" || s.status === "error", 180_000);
    const got = await u.check();
    if (got.status === "error") throw new Error(got.error);
    const s = await ready;
    if (s.status !== "ready") throw new Error(`ended in ${s.status}: ${s.error}`);
    if (s.version !== "99.0.0") throw new Error(`version ${s.version}`);
    ok("downloaded and verified the newer build", `${seen.filter((x, i) => seen[i - 1] !== x).join(" → ")}`);
    const pending = path.join(process.env.LOCALAPPDATA, "ahoy-launcher-updater", "pending");
    const files = fs.existsSync(pending) ? fs.readdirSync(pending) : [];
    if (!files.some(f => f.endsWith(".exe"))) throw new Error(`no installer in ${pending}: ${files.join(", ")}`);
    const got2 = fs.readFileSync(path.join(pending, files.find(f => f.endsWith(".exe"))));
    if (crypto.createHash("sha512").update(got2).digest("base64") !== sha512) throw new Error("the cached installer differs from the published one");
    ok("the installer sits in the cache, byte for byte", `${(got2.length / 1e6).toFixed(0)} MB`);

    // a server with nothing published: quiet "none", not a red error
    publish = false;
    const u2 = new Updater(() => {}, { devConfig, installOnQuit: false });
    u2.state = { status: "idle", version: null, percent: 0, error: null, checkedAt: null };
    u2.follow(feed + "/other");            // a new feed, so it is not deduplicated
    const r2 = await u2.check();
    await new Promise(r => setTimeout(r, 500));
    if (u2.state.status !== "none" || u2.state.error) throw new Error(`got ${u2.state.status}: ${u2.state.error}`);
    ok("a feed with no latest.yml settles on \"none\"");

    const fresh = () => { const x = new Updater(() => {}, { devConfig, installOnQuit: false }); x.state = { status: "idle", version: null, percent: 0, error: null, checkedAt: null }; return x; };
    const settle = async x => { const t = Date.now(); while (!["error", "ready", "none"].includes(x.state.status)) { if (Date.now() - t > 180_000) throw new Error(`still ${x.state.status}`); await new Promise(r => setTimeout(r, 200)); } return x.state; };
    publish = true;
    // a build whose file is at another address: refused before anything is fetched
    served.length = 0;
    const u3 = fresh(); u3.follow(feed + "/elsewhere"); await u3.check();
    const s3 = await settle(u3);
    if (s3.status !== "error" || !/could not be trusted/.test(s3.error) || served.length) throw new Error(`a file at another address: ${s3.status} ${s3.error}, ${served.length} download(s)`);
    ok("a build whose file sits at another address is not downloaded");
    // a download that does not match the published sha512 never becomes "ready"
    fs.rmSync(path.join(process.env.LOCALAPPDATA, "ahoy-launcher-updater"), { recursive: true, force: true });
    const u4 = fresh(); u4.follow(feed + "/tampered"); await u4.check();
    const s4 = await settle(u4);
    if (s4.status !== "error" || !/sha512/i.test(s4.error)) throw new Error(`a wrong checksum: ${s4.status} ${s4.error}`);
    ok("a download that does not match its sha512 is refused", s4.error.slice(0, 60));
    // plain http to an address on the internet: not followed at all, and said as what it is (off, with the reason), not as
    // an update that failed
    const told = [];
    const u5 = new Updater(s => told.push(s.status), { devConfig, installOnQuit: false });
    u5.state = { status: "idle", version: null, percent: 0, error: null, checkedAt: null };
    u5.follow("http://ahoy.example.com");
    const s5 = await u5.check();
    if (s5.status !== "off" || !/not https/.test(s5.error) || told.join() !== "off") throw new Error(`plain http: ${s5.status} ${s5.error} (told ${told.join()})`);
    ok("a plain-http address that is not on this network gets no say in updates", `${s5.status}: ${s5.error}`);
    // another server after that one: what was said of the old address is not said of the new one
    u5.follow(feed + "/next");
    if (u5.state.status !== "idle" || u5.state.error) throw new Error(`after a server with updates off: ${u5.state.status} ${u5.state.error}`);
    ok("updates being off belongs to that address: the next server starts clean");
    console.log("ALL STEPS PASSED");
    server.close(); cleanup(); process.exitCode = 0; app.quit();
  } catch (e) { fail("updater", e && e.message || e); }
});
