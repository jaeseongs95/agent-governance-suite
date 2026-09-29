// usage: node pertest.mjs <report.json> <test-file> <out.tsv>
// Runs each test alone under strace and records the fsync+fdatasync call count (the "calls" column of the total row).
import { readFileSync, appendFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
const [report, file, out] = process.argv.slice(2);
const tests = JSON.parse(readFileSync(report, "utf8")).testResults.flatMap((r) => r.assertionResults);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
for (const t of tests) {
  const trace = `${out}.strace`;
  const r = spawnSync("strace", ["-f", "-c", "-e", "trace=fsync,fdatasync", "-o", trace, "node_modules/.bin/vitest", "run", file, "-t", `${esc(t.title)}$`], { encoding: "utf8" });
  const row = readFileSync(trace, "utf8").split("\n").find((l) => /\btotal\s*$/.test(l));
  const calls = row ? row.trim().split(/\s+/)[3] : "0";
  const ran = (r.stdout.match(/Tests\s+([^\n]*)/) ?? [])[1] ?? "";
  appendFileSync(out, `${calls}\t${r.status}\t${ran.trim()}\t${t.fullName}\n`);
  rmSync(trace, { force: true });
}
