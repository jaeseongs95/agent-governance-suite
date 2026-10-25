import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { validateDecisionRecordSemantics } from "../../mcp-server/src/decision-record-validator.ts";
import { FileSkillRegistry } from "../../mcp-server/src/registry.ts";
import { ContractValidator } from "../../mcp-server/src/schema-validator.ts";
import { WorkflowService } from "../../mcp-server/src/workflow-service.ts";
import { findPython } from "../../scripts/python-runner.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = "skills/independent-deliberation-panel/evals/fixtures/valid/";
const reduced = JSON.parse(readFileSync(new URL("./fixtures/al08-d0049-strict-partial-one-reviewer.json", import.meta.url), "utf8"));
const temporary = [];
const highError = "HIGH requires at least four eligible completed reviewers";
const criticalError = "CRITICAL requires five or six reviewers";
const target = "b".repeat(64);
const countError = stage => stage === "HIGH" ? highError : criticalError;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const result = await mkdtemp(path.join(tmpdir(), "al08-d0049-"));
  temporary.push(result);
  return result;
}

function panel(stage, reviewers) {
  const record = structuredClone(reduced);
  const reviewer = record.run.workers.find(worker => worker.classification === "reviewer");
  const judge = record.run.workers.find(worker => worker.classification === "judge");
  record.run.stage = stage;
  record.run.workers = [...Array.from({ length: reviewers }, (_, index) => ({
    ...structuredClone(reviewer), id: `r${index + 1}`,
    role: stage === "CRITICAL" && index === 0 ? "red team" : reviewer.role,
  })), judge];
  record.run.completed_worker_ids = record.run.workers.map(worker => worker.id);
  record.panel_manifest = structuredClone(record.run.workers);
  return record;
}

async function pythonVerdict(record) {
  const file = path.join(await directory(), "record.json");
  await writeFile(file, JSON.stringify(record), { flag: "wx" });
  const python = findPython();
  const result = spawnSync(python.command, [...python.prefix, "-B",
    path.join(repository, "skills/independent-deliberation-panel/scripts/validate_decision_record.py"), file, "--json"], {
    encoding: "utf8", timeout: 30_000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  const verdict = JSON.parse(result.stdout);
  expect(result.status, result.stderr || result.stdout).toBe(verdict.valid ? 0 : 1);
  return verdict;
}

async function expectCountOnly(record) {
  // Exact singleton diagnostics prevent unrelated malformed fields from making the negative green.
  expect(validateDecisionRecordSemantics(record)).toEqual([countError(record.run.stage)]);
  const python = await pythonVerdict(record);
  expect(python.valid).toBe(false);
  expect(python.issues).toHaveLength(1);
  expect(python.issues[0].code).toBe(record.run.stage === "HIGH" ? "run.high_contract" : "run.critical_contract");
}

async function expectAccepted(record) {
  expect(validateDecisionRecordSemantics(record)).toEqual([]);
  expect(await pythonVerdict(record)).toEqual({ valid: true, issues: [] });
}

it.each([["HIGH", 1], ["HIGH", 3], ["CRITICAL", 1], ["CRITICAL", 4], ["CRITICAL", 7]])(
  "D0049 strict partial %s with %i reviewers rejects only the panel count", async (stage, reviewers) => {
    const record = panel(stage, reviewers);
    expect(record.run.strict).toBe(true);
    expect(record.run.capability_shortfall).toBe(false);
    expect(record.run.assurance).toBe("partially_independent");
    expect(record.panel_manifest).toEqual(record.run.workers);
    expect(record.run.completed_worker_ids).toEqual(record.run.workers.map(worker => worker.id));
    expect(record.cross_examination).toMatchObject({ decision: "skip", trigger_items: [], selected_item_ids: [], coverage: [], followups: [] });
    expect(record.cross_examination.reason.length).toBeGreaterThan(0);
    await expectCountOnly(record);
  });

it.each(["HIGH", "CRITICAL"])("D0049 strict provisional %s cannot lower the minimum", async stage => {
  const record = panel(stage, 1);
  record.run.assurance = "provisional";
  await expectCountOnly(record);
});

it.each([["HIGH", 4], ["CRITICAL", 5], ["CRITICAL", 6]])(
  "D0049 strict partial %s with %i reviewers remains valid", async (stage, reviewers) => {
    await expectAccepted(panel(stage, reviewers));
  });

it.each(["HIGH", "CRITICAL"])("D0049 degraded partial %s keeps its reduced-panel contract", async stage => {
  const record = panel(stage, 1);
  record.run.strict = false;
  await expectAccepted(record);
});

it.each(["ad01_specialist_cap.json", "ad03_impacted_scope.json"])(
  "D0049 full-panel adaptive partial %s remains valid", async name => {
    const record = JSON.parse(readFileSync(path.join(repository, fixtures, name), "utf8"));
    expect(record.run.strict).toBe(true);
    expect(record.run.assurance).toBe("partially_independent");
    await expectAccepted(record);
  });

it("D0049 an adaptive specialist cannot replace the fourth strict HIGH reviewer", async () => {
  const record = JSON.parse(readFileSync(path.join(repository, fixtures, "ad01_specialist_cap.json"), "utf8"));
  record.run.workers = record.run.workers.filter(worker => worker.id !== "r5");
  record.run.completed_worker_ids = record.run.completed_worker_ids.filter(id => id !== "r5");
  record.panel_manifest = structuredClone(record.run.workers);
  expect(record.run.workers.filter(worker => worker.classification === "reviewer")).toHaveLength(3);
  expect(record.run.specialist_additions).toHaveLength(1);
  expect(record.run.workers.find(worker => worker.id === record.run.specialist_additions[0].worker_id).classification).toBe("adaptive_specialist");
  await expectCountOnly(record);
});

it("D0049 preserves the existing single-agent and CRITICAL reviewer-role guards", async () => {
  const single = panel("HIGH", 4);
  single.run.assurance = "single_agent";
  expect(validateDecisionRecordSemantics(single)).toEqual(["HIGH/CRITICAL assurance is invalid"]);
  const singlePython = await pythonVerdict(single);
  expect(singlePython.valid).toBe(false);
  expect(singlePython.issues.map(issue => issue.message)).toEqual(["HIGH/CRITICAL assurance is invalid"]);
  const critical = panel("CRITICAL", 5);
  critical.run.workers[0].role = "generalist reviewer";
  critical.panel_manifest = structuredClone(critical.run.workers);
  const roleError = "CRITICAL requires a red-team or independent design-assurance reviewer";
  expect(validateDecisionRecordSemantics(critical)).toEqual([roleError]);
  expect((await pythonVerdict(critical)).issues.map(issue => issue.message)).toEqual([roleError]);
});

async function serviceFixture() {
  const root = await directory();
  await mkdir(path.join(root, "skills"));
  await mkdir(path.join(root, "contracts"));
  for (const name of ["freeform-output", "provider-result", "task-envelope"]) {
    await copyFile(path.join(repository, "contracts", `${name}.v1.schema.json`), path.join(root, "contracts", `${name}.v1.schema.json`));
  }
  await copyFile(path.join(repository, "skills/independent-deliberation-panel/contracts/decision-record.v1.schema.json"),
    path.join(root, "contracts/decision-record.v1.schema.json"));
  const descriptor = { schemaVersion: "2.0.0", skillId: "al08-panel", version: "1.0.0", path: "./al08-panel", enabled: true, priority: 10,
    providers: [{ capabilities: ["independent-deliberation"], executionClass: "workflow", phase: "decision-analysis", phaseOrder: 40,
      requiredInputArtifacts: [], inputBindings: [], producedArtifacts: ["decision-record"],
      outputSchema: "contracts/freeform-output.v1.schema.json", resultSchema: "contracts/provider-result.v1.schema.json",
      stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"] },
      selectionCriteria: ["capability match"], preconditions: [], failureHandling: "Return a structured result.",
      gate: { kind: "none", policy: "none", validator: "contracts/decision-record.v1.schema.json" } }] };
  const registry = path.join(root, "skills/registry.json");
  await writeFile(registry, JSON.stringify({ schemaVersion: "2.0.0", skills: [descriptor] }));
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registry, validator), validator);
  // A single-provider low-risk wrapper isolates the real decision-record gate; its submitted record is HIGH/CRITICAL.
  const planned = service.planWorkflow({ schemaVersion: "1.0.0", taskId: "AGS-P1-STRICT-PANEL-COUNT-1026-A",
    objective: "Exercise the declared DecisionRecord gate.", scope: { included: ["record"], excluded: [] },
    acceptanceCriteria: ["Reject an undersized strict panel."], riskLevel: "low", workUnits: [],
    requiredCapabilities: ["independent-deliberation"], constraints: [],
    authorization: { allowedActions: ["read"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
    artifactContracts: [{ capability: "independent-deliberation", produced: [{
      artifactId: "decision-record", schemaId: "fixture/v1", targetDigest: `sha256:${target}`,
    }] }],
  });
  expect(planned.ok, JSON.stringify(planned.error)).toBe(true);
  expect(planned.data.state).toBe("ready");
  expect(planned.data.executionMode).toBe("orchestrated");
  const started = service.startWorkflow(planned.data);
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  expect(started.data.plan.stages).toHaveLength(1);
  const receipt = started.data, stage = receipt.plan.stages[0];
  const result = record => ({ schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision,
    state: "passed", executionContext: null,
    output: { schemaVersion: "1.0.0", kind: "output", output: { decisionRecord: record },
      artifacts: [{ artifactId: "decision-record", schemaId: "fixture/v1", locator: "fixture/decision-record.json",
        digest: "a".repeat(64), targetDigest: target, verified: true }], error: null },
    evidence: [{ artifactId: "decision-record", kind: "test", locator: "fixture/decision-record.json", verified: true, note: "fixture verified" }],
    findings: [], blockers: [], error: null });
  return { service, receipt, stage, result };
}

it.each(["HIGH", "CRITICAL"])("D0049 actual MCP %s rejection preserves revision and stage results", async stageName => {
  const { service, receipt, stage, result } = await serviceFixture();
  const before = structuredClone(service.getWorkflowStatus(receipt.runId).data);
  const rejected = service.recordStageResult(result(panel(stageName, 1)));
  expect(rejected.ok).toBe(false);
  expect(rejected.error.code).toBe("GATE_FAILED");
  expect(rejected.error.details).toMatchObject({ stageId: stage.stageId, semanticErrors: [countError(stageName)] });
  const after = service.getWorkflowStatus(receipt.runId).data;
  expect(after).toEqual(before);
  expect(after.revision).toBe(receipt.revision);
  expect(after.stageResults).toEqual([]);
  // The same revision and same gate accept a complete partial panel, ruling out setup/schema/artifact false positives.
  const accepted = service.recordStageResult(result(panel(stageName, stageName === "HIGH" ? 4 : 5)));
  expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
  expect(accepted.data.revision).toBe(receipt.revision + 1);
  expect(accepted.data.stageResults).toHaveLength(1);
  expect(accepted.data.stageResults[0].state).toBe("passed");
});
