import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

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
const { run, evaluationRoot, cycleDirectory } = parseArguments(args);
const layout = await resolveLayout(evaluationRoot, run, cycleDirectory);
const [inputText, selectionText, editingText, verificationText, finalText, manifestText, receiptText] = await Promise.all([
  readFile(layout.inputPath, "utf8"),
  readFile(layout.selectionPath, "utf8"),
  readFile(layout.editingPath, "utf8"),
  readFile(layout.verificationPath, "utf8"),
  readFile(layout.finalPath, "utf8"),
  readFile(layout.manifestPath, "utf8"),
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

  assertNoRawText(receiptText, [inputText, selectionText, editingText, verificationText, finalText]);
  assertNoRawText(row.receipt_json, [inputText, selectionText, editingText, verificationText, finalText]);
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
  const defaultCycle = path.join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
  const explicitCycle = cycleArgument
    ? (path.isAbsolute(cycleArgument) ? path.resolve(cycleArgument) : path.resolve(evaluationRoot, cycleArgument))
    : null;
  if (explicitCycle) {
    await access(explicitCycle);
    if (await exists(path.join(explicitCycle, `run-${run}`, "selection.jsonl"))) return legacyLayout(explicitCycle, run);
    return cycleLayout(explicitCycle, run);
  }
  if (await exists(defaultCycle)) return cycleLayout(defaultCycle, run);
  return legacyLayout(path.join(evaluationRoot, "evals", "runs"), run);
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

function assertNoRawText(receiptTextValue: string, artifactTexts: string[]): void {
  const rawValues = new Set<string>();
  for (const text of artifactTexts) {
    for (const record of parseJsonl(text)) collectRawText(record, rawValues);
  }
  for (const raw of rawValues) {
    if (receiptTextValue.includes(raw)) throw new Error("raw prose leaked into a receipt surface");
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

function artifactDigest(text: string, format: "json" | "jsonl", structured: boolean): string {
  return sha256(structured ? canonicalArtifact(text, format) : text);
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

async function exists(target: string): Promise<boolean> {
  return access(target).then(() => true, () => false);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
