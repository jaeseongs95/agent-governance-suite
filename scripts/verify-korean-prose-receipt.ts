import { hash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import {
  assertNoRawText,
  canonicalArtifact,
  evaluateKoreanProseReadiness,
  exists,
  parseEvaluationRunArguments,
  resolveEvaluationLayout,
} from "./korean-prose-readiness.js";

interface ReceiptStage {
  requiredCapability: string;
  requiredInputArtifacts: string[];
  inputBindings: Array<{ targetArtifact: string; sources: string[] }>;
}

interface ReceiptStageResult {
  stageId: string;
  output?: {
    output?: {
      actorId?: string;
      actorIds?: string[];
      digest?: Record<string, string>;
    };
    artifacts?: Array<{ artifactId: string; digest: string; verified: boolean }>;
  };
  evidence?: Array<{ artifactId: string; locator: string; verified: boolean }>;
}

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const { run, evaluationRoot, cycleDirectory, digests } = parseEvaluationRunArguments(
  args,
  ["--expected-frame-digest", "--expected-validity-report-digest", "--expected-quality-report-digest"],
  "usage: <run:1|2|3> <evaluation-root> [cycle-path | --cycle-dir <cycle-path>] [--expected-frame-digest <sha256:digest>] [--expected-validity-report-digest <sha256:digest>] [--expected-quality-report-digest <sha256:digest>]",
);
const expectedFrameDigest = digests.get("--expected-frame-digest") ?? null;
const expectedValidityReportDigest = digests.get("--expected-validity-report-digest") ?? null;
const expectedQualityReportDigest = digests.get("--expected-quality-report-digest") ?? null;
const layout = await resolveEvaluationLayout(evaluationRoot, run, cycleDirectory, ["evals", "cycles", "0.1.0-rc2"]);
// A structured cycle is formal once it has a frozen frame; its receipt binding stands in for the manifest.
const formal = layout.structured && await exists(path.join(layout.cycleDirectory!, "evaluation-frame.json"));
const manifestPath = layout.structured ? path.join(layout.runDirectory, "receipt-binding.json") : layout.manifestPath;
if (formal) {
  if (!expectedFrameDigest || !expectedValidityReportDigest) {
    throw new Error("--expected-frame-digest and --expected-validity-report-digest are required for a formal structured cycle");
  }
  // Once quality-report.json exists the readiness check re-aggregates the quality evidence and
  // therefore needs the externally held quality digest as well; the flag is optional before that.
  const qualityRecorded = await exists(path.join(layout.cycleDirectory!, "quality-report.json"));
  if (qualityRecorded && !expectedQualityReportDigest) {
    throw new Error("--expected-quality-report-digest is required once quality-report.json exists in the cycle");
  }
  await evaluateKoreanProseReadiness(layout.cycleDirectory!, {
    requireQuality: qualityRecorded,
    expectedFrameDigest,
    expectedValidityReportDigest,
    ...(qualityRecorded && expectedQualityReportDigest ? { expectedQualityReportDigest } : {}),
    evaluationRoot,
  });
}
const [inputText, selectionText, editingText, verificationText, finalText, manifestText, receiptText] = await Promise.all([
  readFile(layout.inputPath, "utf8"),
  readFile(layout.selectionPath, "utf8"),
  readFile(layout.editingPath, "utf8"),
  readFile(layout.verificationPath, "utf8"),
  readFile(layout.finalPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(path.join(layout.runDirectory, "workflow-receipt.json"), "utf8"),
]);
const receipt = JSON.parse(receiptText) as {
  runId: string;
  revision: number;
  plan: { stages: ReceiptStage[] };
  stageResults: ReceiptStageResult[];
};
if (receipt.revision !== 5 || receipt.stageResults.length !== 4) throw new Error("workflow receipt is not finalized after four stages");

const actors = receipt.stageResults.slice(0, 3).map((result) => result.output?.output?.actorId);
const finalActors = receipt.stageResults[3]?.output?.output?.actorIds;
if (actors.some((actor) => typeof actor !== "string") || new Set(actors).size !== 3 || JSON.stringify(actors) !== JSON.stringify(finalActors)) {
  throw new Error("workflow receipt actor binding is invalid");
}

const expectedDigests = {
  source: artifactDigest(inputText, "jsonl", layout.structured),
  selection: artifactDigest(selectionText, "jsonl", layout.structured),
  editing: artifactDigest(editingText, "jsonl", layout.structured),
  verification: artifactDigest(verificationText, "jsonl", layout.structured),
  final: artifactDigest(finalText, "jsonl", layout.structured),
  manifest: artifactDigest(manifestText, "json", layout.structured),
};
assertArtifactDigest(receipt.stageResults[0], "edit-decision-set", expectedDigests.selection);
assertArtifactDigest(receipt.stageResults[1], "edit-candidate", expectedDigests.editing);
assertArtifactDigest(receipt.stageResults[2], "edit-verification-report", expectedDigests.verification);
assertArtifactDigest(receipt.stageResults[3], "final-text-receipt", expectedDigests.final);
if (receipt.stageResults[0]?.output?.output?.digest?.source !== expectedDigests.source
  || receipt.stageResults[3]?.output?.output?.digest?.result !== expectedDigests.final
  || receipt.stageResults[3]?.output?.output?.digest?.manifest !== expectedDigests.manifest) {
  throw new Error("workflow receipt artifact digests do not match evaluation work products");
}
if (layout.structured) assertSelectionReachesFinalization(receipt);

const database = new DatabaseSync(path.join(layout.runDirectory, "workflow.sqlite3"), { readOnly: true });
try {
  const row = database.prepare("SELECT receipt_json FROM workflow_runs WHERE run_id = ?").get(receipt.runId) as { receipt_json: string } | undefined;
  if (!row) throw new Error("persisted workflow receipt is missing");
  if (JSON.stringify(JSON.parse(row.receipt_json)) !== JSON.stringify(receipt)) throw new Error("SQLite and file receipts differ");

  const artifactTexts = [inputText, selectionText, editingText, verificationText, finalText];
  assertNoRawText(receiptText, artifactTexts, "raw prose leaked into a receipt surface");
  assertNoRawText(row.receipt_json, artifactTexts, "raw prose leaked into a receipt surface");
  const layoutSummary = layout.structured ? "bound selection artifact" : "legacy artifact layout";
  console.log(`verified run ${run}: four stages, three actors, ${layoutSummary}, no raw prose in receipt or SQLite`);
} finally {
  database.close();
}

function assertSelectionReachesFinalization(receiptValue: {
  plan: { stages: ReceiptStage[] };
  stageResults: ReceiptStageResult[];
}): void {
  const finalStageIndex = receiptValue.plan.stages.findIndex((stage) => stage.requiredCapability === "korean-prose-finalization");
  const finalStage = receiptValue.plan.stages[finalStageIndex];
  const finalResult = receiptValue.stageResults[finalStageIndex];
  if (!finalStage?.requiredInputArtifacts.includes("edit-decision-set")) {
    throw new Error("finalization plan is missing the selection artifact prerequisite");
  }
  const binding = finalStage.inputBindings.find((item) => item.targetArtifact === "edit-decision-set");
  if (!binding?.sources.includes("provider:korean-prose-selection.edit-decision-set")) {
    throw new Error("finalization plan is missing the selection provider binding");
  }
  if (!finalResult?.evidence?.some((item) => item.artifactId === "edit-decision-set" && item.verified && item.locator)) {
    throw new Error("finalization receipt is missing verified selection artifact evidence");
  }
}

function assertArtifactDigest(result: ReceiptStageResult | undefined, artifactId: string, expectedDigest: string): void {
  const artifact = result?.output?.artifacts?.find((item) => item.artifactId === artifactId);
  if (!artifact?.verified || artifact.digest !== expectedDigest) throw new Error(`${artifactId} digest does not match its work product`);
}

function artifactDigest(text: string, format: "json" | "jsonl", structured: boolean): string {
  return hash("sha256", structured ? canonicalArtifact(text, format) : text);
}

