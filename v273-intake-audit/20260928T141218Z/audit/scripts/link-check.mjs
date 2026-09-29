// Check relative links (and heading anchors) plus external repository links in files changed by the candidate.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
const [repo, base, head] = process.argv.slice(2);
const files = execFileSync("git", ["-C", repo, "diff", "--name-only", base, head], { encoding: "utf8" }).trim().split("\n").filter((f) => /\.(md|json|mjs|ts)$/u.test(f));
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/gu, "-");
let bad = 0;
for (const f of files) {
  const text = readFileSync(join(repo, f), "utf8");
  for (const m of text.matchAll(/https?:\/\/github\.com\/[^\s)"'`]+/gu)) { console.log(`EXTERNAL ${f}: ${m[0]}`); }
  if (!f.endsWith(".md") && !f.endsWith(".json")) continue;
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const target = m[1]; if (/^(https?:|mailto:|#)/u.test(target) && !target.startsWith("#")) continue;
    const [p, anchor] = target.split("#");
    const abs = p ? resolve(dirname(join(repo, f)), p) : join(repo, f);
    if (!existsSync(abs)) { console.log(`BROKEN ${f}: ${target}`); bad++; continue; }
    if (anchor && abs.endsWith(".md")) {
      const heads = [...readFileSync(abs, "utf8").matchAll(/^#{1,6} (.+)$/gmu)].map((h) => slug(h[1]));
      if (!heads.includes(decodeURIComponent(anchor))) { console.log(`BROKEN-ANCHOR ${f}: ${target}`); bad++; } else console.log(`OK ${f}: ${target}`);
    } else console.log(`OK ${f}: ${target}`);
  }
}
console.log(`checked ${files.length} files, broken=${bad}`); process.exit(bad ? 1 : 0);
