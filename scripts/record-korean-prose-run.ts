import { createHash } from "node:crypto";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import type { PlannedStageV1, RoutedSkillProviderV2, StageResultV1, TaskEnvelopeV1 } from "../contracts/types.js";
import { FileSkillRegistry } from "../mcp-server/src/registry.js";
import { ContractValidator } from "../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../mcp-server/src/workflow-service.js";
import { preflightKoreanProseEvaluation } from "./korean-prose-evaluation-preflight.js";

interface EvaluationLayout {
  runDirectory: string;
  inputPath: string;
  manifestPath: string;
  selectionPath: string;
  editingPath: string;
  verificationPath: string;
  finalPath: string;
  structured: boolean;
}

class EvaluationSkillRegistry extends FileSkillRegistry {
  override read(): RoutedSkillProviderV2[] {
    return super.read().map((provider) => (
      provider.skillId === "korean-prose-editor" ? { ...provider, enabled: true } : provider
    ));
  }
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const { run, evaluationRoot, cycleDirectory } = parseArguments(args);
const layout = await resolveLayout(evaluationRoot, run, cycleDirectory);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const databasePath = path.join(layout.runDirectory, "workflow.sqlite3");
const receiptPath = path.join(layout.runDirectory, "workflow-receipt.json");
await Promise.all([databasePath, receiptPath].map(refuseExisting));
if (!layout.structured) await preflightKoreanProseEvaluation("record", run, evaluationRoot);

const [inputText, selectionText, editingText, verificationText, finalText, metricsText, manifestText, selectionMeta, editingMeta, verificationMeta] = await Promise.all([
  readFile(layout.inputPath, "utf8"),
  readFile(layout.selectionPath, "utf8"),
  readFile(layout.editingPath, "utf8"),
  readFile(layout.verificationPath, "utf8"),
  readFile(layout.finalPath, "utf8"),
  readFile(path.join(layout.runDirectory, "metrics.json"), "utf8"),
  readFile(layout.manifestPath, "utf8"),
  readJson(path.join(layout.runDirectory, "selection-meta.json")),
  readJson(path.join(layout.runDirectory, "editing-meta.json")),
  readJson(path.join(layout.runDirectory, "verification-meta.json")),
]);
const metrics = JSON.parse(metricsText) as {
  actorIds: string[];
  counts: {
    selection?: Record<string, number>;
    final?: Record<string, number>;
    restored?: number;
    proposedEdits?: number;
    acceptedEdits?: number;
    retainedEdits?: number;
  };
};
const actorIds = [selectionMeta.actorId, editingMeta.actorId, verificationMeta.actorId] as string[];
if (new Set(actorIds).size !== 3 || JSON.stringify(actorIds) !== JSON.stringify(metrics.actorIds)) throw new Error("actor binding mismatch");

const digestText = (text: string, format: "json" | "jsonl" | "raw") => (
  layout.structured && format !== "raw" ? sha256(canonicalArtifact(text, format)) : sha256(text)
);
const digests = {
  source: digestText(inputText, "jsonl"),
  selection: digestText(selectionText, "jsonl"),
  editing: digestText(editingText, "jsonl"),
  verification: digestText(verificationText, "jsonl"),
  final: digestText(finalText, "jsonl"),
  rubric: sha256(await readFile(path.join(evaluationRoot, "skills", "korean-prose-editor", "references", "verification-rubric.md"))),
  manifest: digestText(manifestText, "json"),
};
const counts = normalizedCounts(metrics, parseJsonl(selectionText));
const finalEditDigests = collectFinalEditDigests(parseJsonl(finalText));

const validator = new ContractValidator();
const store = new SqliteWorkflowStore(databasePath);
try {
  const service = new WorkflowService(new EvaluationSkillRegistry(path.join(repositoryRoot, "skills", "registry.json"), validator), validator, store);
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0",
    taskId: `korean-prose-evaluation-run-${run}`,
    objective: "Evaluate a frozen Korean prose corpus through the four-stage workflow.",
    scope: { included: ["frozen-evaluation-artifacts"], excluded: ["publication", "raw-prose-persistence"] },
    acceptanceCriteria: ["Preserve reference-only receipts.", "Use three distinct language actors."],
    riskLevel: "low",
    workUnits: [],
    requiredCapabilities: ["korean-prose-editing"],
    constraints: ["MCP receipts contain metadata only."],
    authorization: { allowedActions: ["record-evaluation-receipts"], prohibitedActions: ["publish"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
  const planResult = service.planWorkflow(task);
  if (!planResult.ok || !planResult.data) throw new Error(`plan failed: ${JSON.stringify(planResult.error)}`);
  const started = service.startWorkflow(planResult.data);
  if (!started.ok || !started.data) throw new Error(`start failed: ${JSON.stringify(started.error)}`);
  let receipt = started.data;
  for (const stage of receipt.plan.stages) {
    const result = stageResult(receipt.runId, receipt.revision, stage);
    const recorded = service.recordStageResult(result);
    if (!recorded.ok || !recorded.data) throw new Error(`stage ${stage.requiredCapability} failed: ${JSON.stringify(recorded.error)}`);
    receipt = recorded.data;
  }
  const finalized = service.finalizeWorkflow(receipt.runId, receipt.revision);
  if (!finalized.ok || !finalized.data) throw new Error(`finalize failed: ${JSON.stringify(finalized.error)}`);
  const serialized = `${JSON.stringify(finalized.data, null, 2)}\n`;
  assertNoRawText(serialized, [inputText, selectionText, editingText, verificationText, finalText]);
  await writeFile(receiptPath, serialized, "utf8");
  const persistedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = persistedDatabase.prepare("SELECT receipt_json FROM workflow_runs WHERE run_id = ?").get(finalized.data.runId) as { receipt_json: string } | undefined;
    if (!row) throw new Error("persisted workflow receipt is missing");
    assertNoRawText(row.receipt_json, [inputText, selectionText, editingText, verificationText, finalText]);
    if (JSON.stringify(JSON.parse(row.receipt_json)) !== JSON.stringify(finalized.data)) {
      throw new Error("persisted workflow receipt differs from finalized receipt");
    }
  } finally {
    persistedDatabase.close();
  }
  console.log(`recorded ${finalized.data.runId} revision ${finalized.data.revision}`);

  function stageResult(runId: string, expectedRevision: number, stage: PlannedStageV1): StageResultV1 {
    const artifactId = stage.producedArtifacts[0]!;
    const base = {
      schemaVersion: "1.0.0",
      digest: { source: digests.source, artifact: digests.selection },
      length: { source: inputText.length },
      decisions: {
        status: "ready",
        selectedCount: counts.selected,
        retainedCount: counts.selectionRetained,
      },
      warnings: [],
    };
    const output = stage.requiredCapability === "korean-prose-selection" ? { ...base, actorId: actorIds[0] }
      : stage.requiredCapability === "korean-prose-editing" ? {
          schemaVersion: "1.0.0", actorId: actorIds[1],
          digest: { source: digests.source, candidate: digests.editing, artifact: digests.editing },
          length: { source: inputText.length, candidate: editingText.length },
          decisions: { status: "ready", editCount: counts.selected }, warnings: [],
        }
      : stage.requiredCapability === "korean-prose-verification" ? {
          schemaVersion: "1.0.0", actorId: actorIds[2],
          digest: { source: digests.source, candidate: digests.editing, rubric: digests.rubric, artifact: digests.verification },
          length: { source: inputText.length, candidate: editingText.length },
          decisions: { status: counts.partial ? "partial" : "verified", acceptedCount: counts.accepted, retainedCount: counts.retained, fallback: false }, warnings: [],
        }
      : {
          schemaVersion: "1.0.0", actorIds,
          digest: { source: digests.source, result: digests.final, manifest: digests.manifest },
          length: { source: inputText.length, result: finalText.length },
          decisions: {
            mode: "mcp", assurance: "verified", status: "finalized",
            appliedEditDigests: finalEditDigests.applied,
            retainedEditDigests: finalEditDigests.retained,
            fallback: false,
          }, warnings: [],
        };
    const artifactDigest = stage.requiredCapability === "korean-prose-selection" ? digests.selection
      : stage.requiredCapability === "korean-prose-editing" ? digests.editing
      : stage.requiredCapability === "korean-prose-verification" ? digests.verification
      : digests.final;
    const artifacts = [{ artifactId, schemaId: `schema://korean-prose/${artifactId}`, locator: `artifact://evaluation/run-${run}/${artifactId}`, digest: artifactDigest, targetDigest: digests.source, verified: true }];
    if (stage.requiredArtifacts.includes("gate-verdict") && artifactId !== "gate-verdict") {
      artifacts.push({ artifactId: "gate-verdict", schemaId: "schema://korean-prose/gate-verdict", locator: `artifact://evaluation/run-${run}/gate-verdict`, digest: digestText(metricsText, "json"), targetDigest: digests.source, verified: true });
    }
    return {
      schemaVersion: "1.0.0",
      runId,
      stageId: stage.stageId,
      expectedRevision,
      state: "passed",
      output: {
        schemaVersion: "1.0.0",
        kind: "output",
        output,
        artifacts,
        error: null,
      },
      evidence: stage.requiredInputArtifacts.map((required) => ({ artifactId: required, kind: "document", locator: `artifact://evaluation/run-${run}/${required}`, verified: true, note: "" })),
      findings: [],
      blockers: [],
      error: null,
    };
  }
} finally {
  store.close();
}

function parseArguments(cliArgs: string[]): { run: number; evaluationRoot: string; cycleDirectory: string | null } {
  const positional: string[] = [];
  let flaggedCycle: string | null = null;
  for (let index = 0; index < cliArgs.length; index += 1) {
    const argument = cliArgs[index]!;
    if (argument === "--cycle-dir") {
      const value = cliArgs[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--cycle-dir requires a path");
      flaggedCycle = value;
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  const run = Number(positional[0]);
  const evaluationRoot = positional[1] ? path.resolve(positional[1]) : "";
  const positionalCycle = positional[2] ?? null;
  if (![1, 2, 3].includes(run) || !evaluationRoot || positional.length > 3 || (flaggedCycle && positionalCycle)) {
    throw new Error("usage: <run:1|2|3> <evaluation-root> [cycle-path | --cycle-dir <cycle-path>]");
  }
  return { run, evaluationRoot, cycleDirectory: flaggedCycle ?? positionalCycle };
}

async function resolveLayout(evaluationRoot: string, run: number, cycleArgument: string | null): Promise<EvaluationLayout> {
  const resolvedEvaluationRoot = await realpath(evaluationRoot);
  const defaultCycle = path.join(resolvedEvaluationRoot, "evals", "cycles", "0.1.0-rc2");
  const explicitCycle = cycleArgument ? await realpath(path.isAbsolute(cycleArgument)
    ? path.resolve(cycleArgument)
    : path.resolve(resolvedEvaluationRoot, cycleArgument)) : null;
  if (explicitCycle) {
    assertContainedPath(resolvedEvaluationRoot, explicitCycle);
    if (await exists(path.join(explicitCycle, `run-${run}`, "selection.jsonl"))) return legacyLayout(explicitCycle, run);
    return cycleLayout(explicitCycle, run);
  }
  if (await exists(defaultCycle)) return cycleLayout(defaultCycle, run);
  return legacyLayout(path.join(resolvedEvaluationRoot, "evals", "runs"), run);
}

function assertContainedPath(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("cycle directory must be inside the evaluation root");
  }
}

function legacyLayout(legacyBase: string, run: number): EvaluationLayout {
  return {
    runDirectory: path.join(legacyBase, `run-${run}`),
    inputPath: path.join(legacyBase, "input.jsonl"),
    manifestPath: path.join(legacyBase, "manifest.json"),
    selectionPath: path.join(legacyBase, `run-${run}`, "selection.jsonl"),
    editingPath: path.join(legacyBase, `run-${run}`, "candidate.jsonl"),
    verificationPath: path.join(legacyBase, `run-${run}`, "verification.jsonl"),
    finalPath: path.join(legacyBase, `run-${run}`, "final.jsonl"),
    structured: false,
  };
}

function cycleLayout(cycleDirectory: string, run: number): EvaluationLayout {
  const runDirectory = path.join(cycleDirectory, "runs", `run-${run}`);
  return {
    runDirectory,
    inputPath: path.join(cycleDirectory, "input.jsonl"),
    manifestPath: path.join(cycleDirectory, "manifest.json"),
    selectionPath: path.join(runDirectory, "selection-work-product.jsonl"),
    editingPath: path.join(runDirectory, "editing-work-product.jsonl"),
    verificationPath: path.join(runDirectory, "verification-work-product.jsonl"),
    finalPath: path.join(runDirectory, "final.jsonl"),
    structured: true,
  };
}

function normalizedCounts(metrics: { counts: Record<string, unknown> }, selectionRecords: Array<Record<string, unknown>>): {
  selected: number;
  selectionRetained: number;
  accepted: number;
  retained: number;
  partial: boolean;
} {
  const selection = metrics.counts.selection as Record<string, number> | undefined;
  const final = metrics.counts.final as Record<string, number> | undefined;
  const structuredSelection = selectionRecords.flatMap((record) => Array.isArray(record.decisions) ? record.decisions : [])
    .filter((decision): decision is Record<string, unknown> => Boolean(decision) && typeof decision === "object");
  const selected = numeric(metrics.counts.proposedEdits)
    ?? selection?.edit
    ?? structuredSelection.filter((decision) => decision.action === "edit").length;
  const selectionRetained = selection
    ? (selection.retain ?? 0) + (selection.defer ?? 0)
    : structuredSelection.filter((decision) => decision.action === "retain" || decision.action === "defer").length;
  const accepted = numeric(metrics.counts.acceptedEdits) ?? final?.edit ?? 0;
  const retained = numeric(metrics.counts.retainedEdits) ?? final?.retain ?? 0;
  const partial = (numeric(metrics.counts.restored) ?? 0) > 0 || (numeric(metrics.counts.retainedEdits) ?? 0) > 0;
  return { selected, selectionRetained, accepted, retained, partial };
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function collectFinalEditDigests(records: Array<Record<string, unknown>>): { applied: string[]; retained: string[] } {
  const applied = new Set<string>();
  const retained = new Set<string>();
  for (const record of records) {
    const editResults = record.editResults;
    if (Array.isArray(editResults)) {
      for (const item of editResults) {
        if (!item || typeof item !== "object") continue;
        const edit = item as Record<string, unknown>;
        if (typeof edit.editId !== "string") continue;
        const decision = String(edit.decision ?? "");
        (decision === "accept" || decision === "edit" || decision === "apply" ? applied : retained).add(sha256(edit.editId));
      }
      continue;
    }
    if (typeof record.id === "string") {
      (record.finalAction === "edit" ? applied : retained).add(sha256(record.id));
    }
  }
  return { applied: [...applied], retained: [...retained] };
}

function assertNoRawText(receiptText: string, artifactTexts: string[]): void {
  const rawValues = new Set<string>();
  for (const text of artifactTexts) {
    for (const record of parseJsonl(text)) collectRawText(record, rawValues);
  }
  for (const raw of rawValues) {
    if (receiptText.includes(raw)) throw new Error("raw prose leaked into a workflow receipt surface");
  }
}

function collectRawText(value: unknown, destination: Set<string>, key = ""): void {
  if (typeof value === "string") {
    if (/^(?:text|prose|replacement|context|userRequest|meaningConstraints)$/iu.test(key)
      || /(?:source|candidate|final|original|replacement|before|after|context|selected)(?:text|prose|slice|snippet)$/iu.test(key)) {
      if (value.length > 0) destination.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (/^(?:additionalProtectedStrings|protectedStrings)$/iu.test(key)) {
      for (const item of value) if (typeof item === "string" && item.length > 0) destination.add(item);
      return;
    }
    for (const item of value) collectRawText(item, destination, key);
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) collectRawText(child, destination, childKey);
  }
}

function canonicalArtifact(text: string, format: "json" | "jsonl"): string {
  return canonicalJson(format === "jsonl" ? parseJsonl(text) : JSON.parse(text) as unknown);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("artifact contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((entry) => `${JSON.stringify(entry)}:${canonicalJson(record[entry])}`).join(",")}}`;
  }
  throw new Error("artifact contains a non-serializable value");
}

function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

async function refuseExisting(target: string): Promise<void> {
  if (await exists(target)) throw new Error(`refusing to overwrite ${target}`);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
