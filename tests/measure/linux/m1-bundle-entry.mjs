// M1 bundle entry. Built with esbuild into a single .mjs; wasm/data files are placed next to it.
// usage: node app.mjs <default|explicit> <dataDir>
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode, dir] = process.argv.slice(2);
const here = path.dirname(fileURLToPath(import.meta.url));
const opts = {};
if (mode === "explicit") {
  opts.pgliteWasmModule = await WebAssembly.compile(fs.readFileSync(path.join(here, "pglite.wasm")));
  opts.initdbWasmModule = await WebAssembly.compile(fs.readFileSync(path.join(here, "initdb.wasm")));
  opts.fsBundle = new Blob([fs.readFileSync(path.join(here, "pglite.data"))]);
}
const t = performance.now();
const db = new PGlite("file://" + dir, opts);
await db.waitReady;
const r = await db.query("select version() v, 1::int8 a");
console.log(JSON.stringify({ mode, ok: true, ms: Math.round(performance.now() - t), version: r.rows[0].v.slice(0, 40) }));
await db.close();
