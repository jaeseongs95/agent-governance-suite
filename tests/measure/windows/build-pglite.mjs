// M1: bundle pglite-child.mjs into one ESM file (same banner as scripts/runtime-bundles.mjs) and copy the assets beside it.
import { build } from "esbuild";
import fs from "node:fs";

const root = "C:\\ags-measure-dbms";
const dist = `${root}\\b\\dist`;
const pg = `${root}\\node_modules\\@electric-sql\\pglite\\dist`;
fs.mkdirSync(dist, { recursive: true });
const t0 = performance.now();
const r = await build({ entryPoints: [`${root}\\pglite-child.mjs`], bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: `${dist}\\pglite-child.mjs`, logLevel: "warning", metafile: true,
  banner: { js: "import {createRequire as agsRequire} from 'node:module'; const require = agsRequire(import.meta.url);" } });
for (const f of ["pglite.wasm", "initdb.wasm", "pglite.data"]) fs.copyFileSync(`${pg}\\${f}`, `${dist}\\${f}`);
// contrib/amcheck.js resolves "../amcheck.tar.gz" from import.meta.url, i.e. one level above the bundle.
fs.copyFileSync(`${pg}\\amcheck.tar.gz`, `${root}\\b\\amcheck.tar.gz`);
const sizes = Object.fromEntries(fs.readdirSync(dist).map((f) => [f, fs.statSync(`${dist}\\${f}`).size]));
console.log(JSON.stringify({ buildMs: Math.round(performance.now() - t0), warnings: r.warnings.length, sizes }));
