// Pass counts per task, host and arm from results.jsonl: node summary.mjs <results.jsonl>
import { readFileSync } from "node:fs";

const rows = readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.task);
const table = new Map();
for (const row of rows) {
  const key = `${row.task} ${row.host}`;
  const cell = table.get(key) ?? { A: [0, 0, 0], B: [0, 0, 0] };
  cell[row.arm][0] += row.check?.pass ? 1 : 0;
  cell[row.arm][1] += 1;
  cell[row.arm][2] += row.seconds;
  table.set(key, cell);
}
for (const [key, cell] of [...table].sort()) {
  const fmt = ([pass, runs, seconds]) => `${pass}/${runs} (${runs ? Math.round(seconds / runs) : 0}s)`;
  console.log(`${key.padEnd(12)} A ${fmt(cell.A).padEnd(14)} B ${fmt(cell.B)}`);
}
const failed = rows.filter((row) => !row.check?.pass).map((row) => `${row.host}-${row.arm}-${row.task}-${row.rep}: exit=${row.exit} `
  + Object.entries(row.check?.checks ?? {}).filter(([, ok]) => !ok).map(([name]) => name).join(","));
console.log(`\nfailed runs (${failed.length}):\n${failed.join("\n")}`);
