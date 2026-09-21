import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "7bc7753012227938be2a46f68bf3e29d29d5ef34";
const TARGETS = [
  "acceptance-evidence-validator",
  "blocker-diagnostician",
  "change-scope-guardian",
  "codex-token-usage-analyzer",
  "context-continuity",
  "coordinate-subagents",
  "evaluation-validity-auditor",
  "independent-audit-gate",
  "independent-deliberation-panel",
  "instruction-scope-resolver",
  "iteration-frame-auditor",
  "korean-prose-editor",
  "model-effort-advisor",
  "mutation-risk-preflight",
  "orchestrator",
  "recovery-strategy-selector",
  "session-board",
  "software-security-auditor",
  "task-contract",
  "workspace-convention-profiler"
];
const NO_SEPARATOR_SUFFIX = new Set(["context-continuity", "session-board"]);
const README_CHANGES = new Set(["independent-audit-gate", "independent-deliberation-panel"]);
const NAVIGATION = Buffer.from('<!-- optimization-navigation:start condition="the skill is activated for the request" reference="references/entry-details.md" do-not-load-otherwise="true" -->\n- If the skill is activated for the request, read [entry details](references/entry-details.md) before producing any result or taking any action; otherwise do not read it.\n<!-- optimization-navigation:end -->\n');

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { maxBuffer: 20 * 1024 * 1024 });
}

function baselineFile(path) {
  return git("show", `${BASELINE}:${path}`);
}

function frontmatter(bytes) {
  const end = bytes.indexOf(Buffer.from("\n---\n"), 4);
  return bytes.subarray(0, end < 0 ? 0 : end + 5);
}

function sameSet(left, right) {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

export function reconstructOptimizedSkill(skillId, root = ROOT) {
  const candidate = readFileSync(join(root, "skills", skillId, "SKILL.md"));
  const detail = readFileSync(join(root, "skills", skillId, "references", "entry-details.md"));
  const baselineRelativeDetail = Buffer.from(detail.toString("utf8").replace(/\]\((?![A-Za-z][A-Za-z0-9+.-]*:|#|\/)([^)\s]+)\)/gu, (_match, target) => `](${posix.normalize(posix.join("references", target))})`));
  const markerIndex = candidate.indexOf(NAVIGATION);
  if (markerIndex < 0) throw new Error(`${skillId}: navigation marker is missing`);
  const suffix = NO_SEPARATOR_SUFFIX.has(skillId) ? Buffer.alloc(0) : Buffer.from("\n");
  return Buffer.concat([candidate.subarray(0, markerIndex), baselineRelativeDetail, suffix, candidate.subarray(markerIndex + NAVIGATION.length)]);
}

export function checkSkillContextOptimization() {
  const errors = [];
  const detailOwners = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((skillId) => {
      try {
        readFileSync(join(ROOT, "skills", skillId, "references", "entry-details.md"));
        return true;
      } catch {
        return false;
      }
    });
  if (!sameSet(detailOwners, TARGETS)) errors.push("target skill set does not match the 20 reviewed optimization targets");

  let baselineBytes = 0;
  let candidateBytes = 0;
  const skills = [];
  for (const skillId of TARGETS) {
    const skillPath = `skills/${skillId}/SKILL.md`;
    const detailPath = `skills/${skillId}/references/entry-details.md`;
    const baseline = baselineFile(skillPath);
    const candidate = readFileSync(join(ROOT, ...skillPath.split("/")));
    const markerIndex = candidate.indexOf(NAVIGATION);
    const markerCount = candidate.toString("utf8").split("<!-- optimization-navigation:start").length - 1;
    const reconstructed = markerIndex < 0 ? Buffer.alloc(0) : reconstructOptimizedSkill(skillId);

    if (markerCount !== 1 || markerIndex < 0) errors.push(`${skillId}: navigation marker must occur exactly once`);
    if (!reconstructed.equals(baseline)) errors.push(`${skillId}: SKILL.md plus entry-details.md does not reconstruct the baseline byte-for-byte`);
    if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push(`${skillId}: frontmatter changed`);
    if (candidate.length >= baseline.length) errors.push(`${skillId}: initial SKILL.md did not shrink`);

    const descriptorPath = `skills/${skillId}/agents/openai.yaml`;
    if (!readFileSync(join(ROOT, ...descriptorPath.split("/"))).equals(baselineFile(descriptorPath))) errors.push(`${skillId}: agents/openai.yaml changed`);

    const allowed = new Set([skillPath, detailPath]);
    if (README_CHANGES.has(skillId)) allowed.add(`skills/${skillId}/README.md`);
    const changed = git("diff", "--name-only", BASELINE, "--", `skills/${skillId}`).toString("utf8").trim().split(/\r?\n/u).filter(Boolean);
    const unexpected = changed.filter((path) => !allowed.has(path));
    if (unexpected.length) errors.push(`${skillId}: unexpected skill-owned changes: ${unexpected.join(", ")}`);

    baselineBytes += baseline.length;
    candidateBytes += candidate.length;
    skills.push({ skillId, baselineBytes: baseline.length, candidateBytes: candidate.length, reducedBytes: baseline.length - candidate.length });
  }

  if (!readFileSync(join(ROOT, "skills", "registry.json")).equals(baselineFile("skills/registry.json"))) errors.push("skills/registry.json changed");
  if (git("diff", "--name-only", BASELINE, "--", "skills/ponytail").toString("utf8").trim()) errors.push("excluded skill ponytail changed");
  if (candidateBytes >= baselineBytes) errors.push("combined initial SKILL.md bytes did not shrink");

  return {
    baselineRevision: BASELINE,
    pass: errors.length === 0,
    errors,
    totals: {
      skillCount: TARGETS.length,
      baselineBytes,
      candidateBytes,
      reducedBytes: baselineBytes - candidateBytes,
      reductionPercent: Number((((baselineBytes - candidateBytes) / baselineBytes) * 100).toFixed(6))
    },
    skills
  };
}

function main() {
  const report = checkSkillContextOptimization();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.pass) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
