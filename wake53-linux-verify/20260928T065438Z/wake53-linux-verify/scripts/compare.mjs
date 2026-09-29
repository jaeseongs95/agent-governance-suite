// Build per-test comparison table (base vs candidate) from vitest JSON outputs.
import fs from "node:fs";
const base = JSON.parse(fs.readFileSync("/tmp/ev/22-base-targeted-test.json", "utf8"));
const cand = JSON.parse(fs.readFileSync("/tmp/ev/23-cand-targeted-test.json", "utf8"));
const root = "/home/user/agent-governance-suite/";
const key = (f, a) => f.name.replace(/^.*?(tests\/)/, "$1") + "::" + a.fullName;
const map = (r) => { const m = new Map(); for (const f of r.testResults) for (const a of f.assertionResults) m.set(key(f, a), a); return m; };
const B = map(base), C = map(cand);
const lineOf = (file, title) => {
  const lines = fs.readFileSync(root + file, "utf8").split("\n");
  const i = lines.findIndex((l) => l.includes(JSON.stringify(title).slice(1, -1)) || l.includes(title));
  return i < 0 ? "?" : i + 1;
};
const rows = [];
for (const k of new Set([...B.keys(), ...C.keys()])) {
  const [file, full] = k.split("::");
  const b = B.get(k), c = C.get(k), t = (b ?? c).title;
  const msg = b && b.status === "failed" ? (b.failureMessages[0] ?? "").split("\n").slice(0, 3).join(" ⏎ ").replace(/\x1b\[[0-9;]*m/g, "").replace(/\|/g, "\\|") : "";
  rows.push({ full, loc: `${file}:${lineOf(file, t)}`, base: b?.status ?? "absent", cand: c?.status ?? "absent", msg });
}
const fmt = (rs) => ["| 전체 이름 | 파일:줄 | 기준 | 후보 | 기준 실패 assertion 요지 |", "|---|---|---|---|---|", ...rs.map((r) => `| ${r.full} | ${r.loc} | ${r.base} | ${r.cand} | ${r.msg} |`)].join("\n");
const diff = rows.filter((r) => r.base !== r.cand);
fs.writeFileSync("/tmp/ev/24-falsification-table.md", `# 반증 비교 (기준 d5c5932c + 후보 테스트 파일 vs 후보 53eff30a)\n\n## 결과가 다른 테스트 (${diff.length})\n\n${fmt(diff)}\n\n## 전체 (${rows.length})\n\n${fmt(rows)}\n`);
console.log(fmt(diff));
