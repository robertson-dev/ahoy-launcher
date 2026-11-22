/** Builds the Electron main and preload bundles into dist/ (bun run build). The version is baked in from package.json. */
import pkg from "./package.json";

const r = await Bun.build({
  // pad.ts: the preload of the window that watches the controllers' home button (never shown)
  entrypoints: ["src/main.ts", "src/preload.ts", "src/pad.ts", ...(process.argv.includes("--with-updater") ? ["src/updater.ts"] : [])],
  outdir: "dist", target: "node", format: "cjs", naming: "[name].cjs",
  external: ["electron"],                               // electron-updater and its deps are bundled in: the packed app ships no node_modules
  define: { __AHOY_VERSION__: JSON.stringify(pkg.version) },
});
if (!r.success) { for (const l of r.logs) console.error(String(l)); process.exit(1); }
console.log(`built ${r.outputs.map(o => o.path.split(/[\\/]/).pop()).join(", ")} (v${pkg.version})`);
