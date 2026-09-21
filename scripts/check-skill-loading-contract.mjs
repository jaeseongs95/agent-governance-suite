import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "release/skill-loading-baseline.json";

/**
 * Current-tree loading invariants. The historical v2.4 byte-equivalence proof lives in
 * check-skill-context-optimization.mjs; this check keeps every later release from growing an
 * initial SKILL.md, changing its frontmatter without a reviewed baseline update, dropping the
 * conditional navigation, or pulling model catalog data into the initial context.
 */
export function checkSkillLoadingContract(root = ROOT) {
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), "utf8"));
  const errors = [];
  let initialContextBytes = 0;
  for (const item of baseline.skills) {
    const file = join(root, ...item.path.split("/"));
    if (!existsSync(file)) {
      errors.push(`${item.path}: missing`);
      continue;
    }
    const content = readFileSync(file);
    const text = content.toString("utf8");
    initialContextBytes += content.length;
    if (content.length > item.maxBytes) errors.push(`${item.path}: initial context grew beyond ${item.maxBytes} bytes`);
    const frontmatter = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u)?.[0];
    if (!frontmatter || createHash("sha256").update(frontmatter).digest("hex") !== item.frontmatterSha256) {
      errors.push(`${item.path}: frontmatter differs from the reviewed baseline`);
    }
    if (item.conditionalNavigation) {
      if (text.split("<!-- optimization-navigation:start ").length !== 2 || !text.includes('do-not-load-otherwise="true"')) {
        errors.push(`${item.path}: conditional navigation must occur exactly once`);
      }
      if (!existsSync(join(dirname(file), "references", "entry-details.md"))) errors.push(`${item.path}: entry details are missing`);
    }
    if (text.includes("model-catalog/")) errors.push(`${item.path}: model catalog data belongs outside the initial context`);
  }
  return { pass: errors.length === 0, revision: baseline.revision, skillCount: baseline.skills.length, initialContextBytes, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkSkillLoadingContract();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}
