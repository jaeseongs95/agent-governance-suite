// Scan every tracked file for sentences of the shared intake block. Usage: node intake-copy-scan.mjs <repo>
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const repo = process.argv[2];
const shared = readFileSync(join(repo, "skills/orchestrator/SKILL.md"), "utf8");
const intake = shared.match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)[1];
const sentences = intake.split("\n").filter((l) => l && !l.startsWith("#")).flatMap((l) => l.replace(/^- /u, "").split(/(?<=다\.) /u)).filter((s) => s.length > 15);
// also scan for 12-char fragments to catch paraphrased partial copies
const fragments = [...new Set(sentences.flatMap((s) => { const out = []; for (let i = 0; i + 16 <= s.length; i += 8) out.push(s.slice(i, i + 16)); return out; }))];
const files = execFileSync("git", ["-C", repo, "ls-files"], { encoding: "utf8" }).trim().split("\n");
const hits = {};
for (const f of files) {
  let t; try { t = readFileSync(join(repo, f), "utf8"); } catch { continue; }
  // also decode \uXXXX escapes (bundles)
  const decoded = t.replace(/\\u([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\xB7/g, "·");
  const full = sentences.filter((s) => decoded.includes(s)).length;
  const frag = fragments.filter((s) => decoded.includes(s)).length;
  if (full || frag) hits[f] = { fullSentences: full, fragments16: frag };
}
console.log(JSON.stringify({ sentenceCount: sentences.length, fragmentCount: fragments.length, hits }, null, 2));
