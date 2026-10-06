// Input preparation only (files and digests). No MCP/service calls.
import { createHash } from "node:crypto";
import { cpSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { convergenceDigest } from "/home/user/repo/mcp-server/src/convergence-logic.ts";
const ST = process.env.ST!; const repo = "/home/user/repo";
const ex = path.join(repo, "claude-plugin/skills/cs-engineering/assets/examples/sqlite-queue");
const read = (r: string, n: string) => JSON.parse(readFileSync(path.join(r, n), "utf8"));
const write = (r: string, n: string, v: unknown) => writeFileSync(path.join(r, n), JSON.stringify(v, null, 2) + "\n");
const dg = (f: string) => "sha256:" + createHash("sha256").update(readFileSync(f)).digest("hex");
function frameFor(root: string, id: string) {
  return { schemaVersion: "1.0.0", workspace: { workspaceId: id, locator: root },
    controlArtifacts: [{ artifactId: "conditions", role: "validator", locator: path.join(root, "constraints.json"), digest: dg(path.join(root, "constraints.json")) }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: path.join(root, "candidate.json"), digest: dg(path.join(root, "candidate.json")) }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
}
function csFlow(name: string) {
  const root = path.join(ST, "flow", name); cpSync(ex, root, { recursive: true });
  const task = read(root, "task.json"); task.requiredCapabilities = ["cs-implementation-review"]; task.orchestration = { requested: true, mcpAvailable: true }; write(root, "task.json", task);
  const binding = read(root, "binding.json"); binding.taskDigest = convergenceDigest(task); write(root, "binding.json", binding);
  write(root, "stage-bundle.json", { schemaVersion: "1.0.0", ...Object.fromEntries(["binding", "task", "policy", "review", "candidate"].map((n) => [n, { path: n + ".json", digest: dg(path.join(root, n + ".json")) }])) });
  const review = read(root, "review.json");
  const frame = frameFor(root, "cs-claude-final-" + name);
  const claimExtra = { actorIdNote: "use the actorId value you choose consistently", outputTargets: ["candidate/queue.py"], priorFailure: null };
  // Template for record_stage_result; runId/stageId/expectedRevision come from start_guarded_workflow's response.
  const stageTemplate = { schemaVersion: "1.0.0", runId: "<from start_guarded_workflow data.runId>", stageId: "<from start_guarded_workflow data.plan.stages[0].stageId>",
    expectedRevision: "<from start_guarded_workflow data.revision (number)>", state: "passed",
    outputFile: { locator: path.join(root, "review.json"), digest: dg(path.join(root, "review.json")) },
    output: { schemaVersion: "1.0.0", kind: "output", output: null, error: null,
      artifacts: [
        { artifactId: "cs-review-bundle", schemaId: "cs-fixture/v1", locator: path.join(root, "stage-bundle.json"), digest: dg(path.join(root, "stage-bundle.json")), targetDigest: review.candidateDigest, verified: true },
        { artifactId: "cs-review-report", schemaId: "cs-fixture/v1", locator: path.join(root, "review.json"), digest: dg(path.join(root, "review.json")), targetDigest: review.candidateDigest, verified: true }] },
    evidence: [{ artifactId: "cs-review-report", kind: "file", locator: path.join(root, "review.json"), verified: true, note: "Checked-in CS sqlite-queue review fixture copied for the Claude host flow" }],
    findings: [], blockers: [], error: null };
  write(root, "_args-task.json", task); write(root, "_args-frame.json", frame); write(root, "_args-claim-extra.json", claimExtra); write(root, "_args-stage-template.json", stageTemplate);
  return root;
}
csFlow("f1b");
// release.md:24 — repo-proportional stage output through outputFile.
const r = path.join(ST, "flow", "r24b"); mkdirSync(r, { recursive: true }); cpSync(path.join(ex, "constraints.json"), path.join(r, "constraints.json")); cpSync(path.join(ex, "candidate.json"), path.join(r, "candidate.json"));
const files = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter(Boolean);
const inv = { kind: "repository-inventory", repository: "agent-governance-suite", commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  fileCount: files.length, files: files.map((f) => ({ path: f, sha256: dg(path.join(repo, f)).slice(7), bytes: readFileSync(path.join(repo, f)).length })) };
write(r, "inventory.json", inv);
const t = read(ex, "task.json"); t.taskId = "TASK-REPO-INVENTORY"; t.objective = "Record a repository-sized file inventory as the stage output."; t.requiredCapabilities = ["minimal-implementation"]; t.orchestration = { requested: true, mcpAvailable: true };
write(r, "_args-task.json", t); write(r, "_args-frame.json", frameFor(r, "cs-claude-final-r24b"));
write(r, "_args-stage-template.json", { schemaVersion: "1.0.0", runId: "<from start>", stageId: "<from start data.plan.stages[0].stageId>", expectedRevision: "<from start data.revision>", state: "passed",
  outputFile: { locator: path.join(r, "inventory.json"), digest: dg(path.join(r, "inventory.json")) },
  output: { schemaVersion: "1.0.0", kind: "output", output: null, error: null, artifacts: [] }, evidence: [{ artifactId: "repository-inventory", kind: "file", locator: path.join(r, "inventory.json"), verified: true, note: "git ls-files inventory with per-file sha256 written by the prep script" }], findings: [], blockers: [], error: null });
console.log(JSON.stringify({ inventoryBytes: readFileSync(path.join(r, "inventory.json")).length, files: files.length }));
