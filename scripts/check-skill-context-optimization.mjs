import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "7bc7753012227938be2a46f68bf3e29d29d5ef34";
// AC-010 adds peer instructions after the reviewed optimization. Preserve all
// historical bytes and compare the exact, separately frozen addition as well.
const SESSION_BOARD_ADDITION = "scripts/fixtures/session-board-peer-message-guidance.2.6.0.md";
const SESSION_BOARD_ADDITION_SHA256 = "381be4018118086b3c4087be043c004d8d6de986d42a6c0c14f182c2d76ed76f";
// Intake changes policy after the original optimization. Pin only this revision;
// all other skills keep their historical byte-for-byte checks.
const ORCHESTRATOR_INTAKE = Object.freeze({
  revision: "2.7.3-intake-selection-timing",
  initialMaxBytes: 4585,
  hashes: Object.freeze({
    reconstructed: "12744ae24122ce513b09152f3e4884b63883c7d15e808fa7b2b6c19c27be3af9",
    frontmatter: "9054478f3909908263ce9f26afaad3b51d2a0db8f1aceacb228b07c6e3dd7bae",
    mcpExecution: "be972eaa9b6d2ceab78f48f37fcc0eb4e1d4ce52cd8cfb5de356f019da46c546",
  }),
});
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
const NODE24_README_MINIMUMS = Object.freeze({
  "acceptance-evidence-validator": "Node.js 22 이상",
  "blocker-diagnostician": "Node.js 22 이상",
  "change-scope-guardian": "Node.js 22 이상",
  "evaluation-validity-auditor": "Node.js 22.13 이상",
  "instruction-scope-resolver": "Node.js 22 이상",
  "mutation-risk-preflight": "Node.js 22 이상",
  "task-contract": "Node.js 22 이상",
  "workspace-convention-profiler": "Node.js 22 이상",
});
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

export function matchesNode24ReadmeUpdate(skillId, baseline, candidate) {
  const minimum = NODE24_README_MINIMUMS[skillId];
  return Boolean(minimum) && baseline.split(minimum).length === 2
    && candidate === baseline.replace(minimum, "Node.js 24.0.0 이상");
}

export function matchesOrchestratorIntakeUpdate(kind, bytes) {
  return Object.hasOwn(ORCHESTRATOR_INTAKE.hashes, kind)
    && createHash("sha256").update(bytes).digest("hex") === ORCHESTRATOR_INTAKE.hashes[kind];
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
    let expectedBaseline = baseline;
    if (skillId === "session-board") {
      const addition = readFileSync(join(ROOT, SESSION_BOARD_ADDITION));
      if (createHash("sha256").update(addition).digest("hex") !== SESSION_BOARD_ADDITION_SHA256) errors.push("session-board: approved 2.6.0 guidance fixture changed");
      expectedBaseline = Buffer.concat([baseline, addition]);
    }
    if (skillId === "orchestrator") {
      if (!matchesOrchestratorIntakeUpdate("reconstructed", reconstructed)) errors.push("orchestrator: reconstructed intake policy differs from the pinned revision");
      if (!matchesOrchestratorIntakeUpdate("frontmatter", frontmatter(candidate))) errors.push("orchestrator: intake frontmatter differs from the pinned revision");
      if (candidate.length > ORCHESTRATOR_INTAKE.initialMaxBytes) errors.push("orchestrator: initial load exceeds the pre-intake limit");
      const reference = readFileSync(join(ROOT, "skills/orchestrator/references/mcp-execution.md"));
      if (!matchesOrchestratorIntakeUpdate("mcpExecution", reference)) errors.push("orchestrator: MCP execution policy differs from the pinned revision");
    } else {
      if (!reconstructed.equals(expectedBaseline)) errors.push(`${skillId}: SKILL.md plus entry-details.md does not reconstruct the baseline byte-for-byte`);
      if (!frontmatter(candidate).equals(frontmatter(baseline))) errors.push(`${skillId}: frontmatter changed`);
    }
    if (candidate.length >= baseline.length) errors.push(`${skillId}: initial SKILL.md did not shrink`);

    const descriptorPath = `skills/${skillId}/agents/openai.yaml`;
    if (!readFileSync(join(ROOT, ...descriptorPath.split("/"))).equals(baselineFile(descriptorPath))) errors.push(`${skillId}: agents/openai.yaml changed`);

    const allowed = new Set([skillPath, detailPath]);
    if (skillId === "orchestrator") allowed.add("skills/orchestrator/references/mcp-execution.md");
    if (README_CHANGES.has(skillId)) allowed.add(`skills/${skillId}/README.md`);
    if (Object.hasOwn(NODE24_README_MINIMUMS, skillId)) {
      const readmePath = `skills/${skillId}/README.md`;
      const baselineReadme = baselineFile(readmePath).toString("utf8").replaceAll("\r\n", "\n");
      const candidateReadme = readFileSync(join(ROOT, ...readmePath.split("/")), "utf8").replaceAll("\r\n", "\n");
      if (!matchesNode24ReadmeUpdate(skillId, baselineReadme, candidateReadme)) errors.push(`${skillId}: README.md differs beyond the Node 24 minimum update`);
      allowed.add(readmePath);
    }
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
    approvedAdditions: [{ skillId: "session-board", path: SESSION_BOARD_ADDITION, sha256: SESSION_BOARD_ADDITION_SHA256 }],
    policyBaselineUpdates: [{ skillId: "orchestrator", ...ORCHESTRATOR_INTAKE }],
    runtimeBaselineUpdates: Object.entries(NODE24_README_MINIMUMS).map(([skillId, before]) => ({ skillId, before, after: "Node.js 24.0.0 이상" })),
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
