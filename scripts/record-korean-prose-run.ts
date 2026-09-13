import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import type { PlannedStageV1, StageResultV1, TaskEnvelopeV1 } from "../contracts/types.js";
import { FileSkillRegistry } from "../mcp-server/src/registry.js";
import { ContractValidator } from "../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../mcp-server/src/workflow-service.js";
import { preflightKoreanProseEvaluation } from "./korean-prose-evaluation-preflight.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const run = Number(args[0]);
const evaluationRoot = args[1] ? path.resolve(args[1]) : null;
if (!Number.isInteger(run) || run < 1 || !evaluationRoot) throw new Error("usage: <positive-run-number> <evaluation-root>");

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const runDirectory = path.join(evaluationRoot, "evals", "runs", `run-${run}`);
const databasePath = path.join(runDirectory, "workflow.sqlite3");
await preflightKoreanProseEvaluation("record", run, evaluationRoot);

const [inputText, selectionText, candidateText, verificationText, finalText, metricsText, manifestText, selectionMeta, editingMeta, verificationMeta] = await Promise.all([
  readFile(path.join(evaluationRoot, "evals", "runs", "input.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "selection.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "candidate.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "verification.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "final.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "metrics.json"), "utf8"),
  readFile(path.join(evaluationRoot, "evals", "runs", "manifest.json"), "utf8"),
  readJson(path.join(runDirectory, "selection-meta.json")),
  readJson(path.join(runDirectory, "editing-meta.json")),
  readJson(path.join(runDirectory, "verification-meta.json")),
]);
const metrics = JSON.parse(metricsText) as {
  actorIds: string[];
  counts: { selection: Record<string, number>; final: Record<string, number>; restored: number };
};
const actorIds = [selectionMeta.actorId, editingMeta.actorId, verificationMeta.actorId] as string[];
if (new Set(actorIds).size !== 3 || JSON.stringify(actorIds) !== JSON.stringify(metrics.actorIds)) throw new Error("actor binding mismatch");

const digests = {
  source: sha256(inputText),
  selection: sha256(selectionText),
  candidate: sha256(candidateText),
  verification: sha256(verificationText),
  final: sha256(finalText),
  rubric: sha256(await readFile(path.join(evaluationRoot, "skills", "korean-prose-editor", "references", "verification-rubric.md"))),
  manifest: sha256(manifestText),
};

const validator = new ContractValidator();
const store = new SqliteWorkflowStore(databasePath);
try {
  const service = new WorkflowService(new FileSkillRegistry(path.join(repositoryRoot, "skills", "registry.json"), validator), validator, store);
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
  let receipt = service.startWorkflow(planResult.data).data;
  if (!receipt) throw new Error("start failed");
  for (const stage of receipt.plan.stages) {
    const result = stageResult(receipt.runId, receipt.revision, stage);
    const recorded = service.recordStageResult(result);
    if (!recorded.ok || !recorded.data) throw new Error(`stage ${stage.requiredCapability} failed: ${JSON.stringify(recorded.error)}`);
    receipt = recorded.data;
  }
  const finalized = service.finalizeWorkflow(receipt.runId, receipt.revision);
  if (!finalized.ok || !finalized.data) throw new Error(`finalize failed: ${JSON.stringify(finalized.error)}`);
  const serialized = `${JSON.stringify(finalized.data, null, 2)}\n`;
  for (const raw of [inputText, selectionText, candidateText, verificationText, finalText]) {
    const firstNonempty = raw.split(/\r?\n/u).find(Boolean);
    if (firstNonempty && serialized.includes(firstNonempty)) throw new Error("raw evaluation text leaked into workflow receipt");
  }
  await writeFile(path.join(runDirectory, "workflow-receipt.json"), serialized, "utf8");
  const persistedDatabase = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = persistedDatabase.prepare("SELECT receipt_json FROM workflow_runs WHERE run_id = ?").get(finalized.data.runId) as { receipt_json: string } | undefined;
    if (!row) throw new Error("persisted workflow receipt is missing");
    const proseValues = new Set<string>();
    for (const record of [...parseJsonl(inputText), ...parseJsonl(candidateText), ...parseJsonl(finalText)]) {
      for (const field of ["sourceText", "candidateText", "finalText"]) {
        const value = record[field];
        if (typeof value === "string" && value.length > 0) proseValues.add(value);
      }
    }
    for (const prose of proseValues) {
      if (row.receipt_json.includes(prose)) throw new Error("raw prose leaked into SQLite receipt_json");
    }
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
        selectedCount: metrics.counts.selection.edit ?? 0,
        retainedCount: (metrics.counts.selection.retain ?? 0) + (metrics.counts.selection.defer ?? 0),
      },
      warnings: [],
    };
    const output = stage.requiredCapability === "korean-prose-selection" ? { ...base, actorId: actorIds[0] }
      : stage.requiredCapability === "korean-prose-editing" ? {
          schemaVersion: "1.0.0", actorId: actorIds[1],
          digest: { source: digests.source, candidate: digests.candidate, artifact: digests.candidate },
          length: { source: inputText.length, candidate: candidateText.length },
          decisions: { status: "ready", editCount: metrics.counts.selection.edit ?? 0 }, warnings: [],
        }
      : stage.requiredCapability === "korean-prose-verification" ? {
          schemaVersion: "1.0.0", actorId: actorIds[2],
          digest: { source: digests.source, candidate: digests.candidate, rubric: digests.rubric, artifact: digests.verification },
          length: { source: inputText.length, candidate: candidateText.length },
          decisions: { status: metrics.counts.restored > 0 ? "partial" : "verified", acceptedCount: metrics.counts.final.edit ?? 0, retainedCount: metrics.counts.final.retain ?? 0, fallback: false }, warnings: [],
        }
      : {
          schemaVersion: "1.0.0", actorIds,
          digest: { source: digests.source, result: digests.final, manifest: digests.manifest },
          length: { source: inputText.length, result: finalText.length },
          decisions: {
            mode: "mcp", assurance: "verified", status: "finalized",
            appliedEditDigests: parseJsonl(finalText).filter((item) => item.finalAction === "edit").map((item) => sha256(item.id)),
            retainedEditDigests: parseJsonl(finalText).filter((item) => item.finalAction !== "edit").map((item) => sha256(item.id)),
            fallback: false,
          }, warnings: [],
        };
    const artifactDigest = stage.requiredCapability === "korean-prose-selection" ? digests.selection
      : stage.requiredCapability === "korean-prose-editing" ? digests.candidate
      : stage.requiredCapability === "korean-prose-verification" ? digests.verification
      : digests.final;
    const artifacts = [{ artifactId, schemaId: `schema://korean-prose/${artifactId}`, locator: `artifact://evaluation/run-${run}/${artifactId}`, digest: artifactDigest, targetDigest: digests.source, verified: true }];
    if (stage.requiredArtifacts.includes("gate-verdict") && artifactId !== "gate-verdict") {
      artifacts.push({ artifactId: "gate-verdict", schemaId: "schema://korean-prose/gate-verdict", locator: `artifact://evaluation/run-${run}/gate-verdict`, digest: sha256(metricsText), targetDigest: digests.source, verified: true });
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

function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
