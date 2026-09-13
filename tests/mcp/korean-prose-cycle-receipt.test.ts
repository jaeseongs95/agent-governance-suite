import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const recorderPath = fileURLToPath(new URL("../../scripts/record-korean-prose-run.ts", import.meta.url));
const verifierPath = fileURLToPath(new URL("../../scripts/verify-korean-prose-receipt.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const actors = [
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  "30000000-0000-4000-8000-000000000003",
] as const;

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("range-aware Korean prose cycle receipts", () => {
  it("records canonical structured work products and binds selection through finalization", async () => {
    const evaluationRoot = await createCycleFixture();
    const positionalCycle = join("evals", "cycles", "0.1.0-rc2");
    const recorded = runScript(recorderPath, ["1", evaluationRoot, positionalCycle]);
    expect(recorded.status, recorded.stderr).toBe(0);

    const runDirectory = join(evaluationRoot, positionalCycle, "runs", "run-1");
    const receiptText = await readFile(join(runDirectory, "workflow-receipt.json"), "utf8");
    const receipt = JSON.parse(receiptText) as {
      plan: { stages: Array<{ requiredCapability: string; requiredInputArtifacts: string[]; inputBindings: Array<{ targetArtifact: string; sources: string[] }> }> };
      stageResults: Array<{
        output: { output: { digest: Record<string, string> } };
        evidence: Array<{ artifactId: string; verified: boolean }>;
      }>;
    };
    const finalIndex = receipt.plan.stages.findIndex((stage) => stage.requiredCapability === "korean-prose-finalization");
    const finalStage = receipt.plan.stages[finalIndex]!;
    expect(finalStage.requiredInputArtifacts).toContain("edit-decision-set");
    expect(finalStage.inputBindings).toContainEqual({
      targetArtifact: "edit-decision-set",
      sources: ["provider:korean-prose-selection.edit-decision-set"],
      operation: "select",
    });
    expect(receipt.stageResults[finalIndex]!.evidence).toContainEqual(expect.objectContaining({
      artifactId: "edit-decision-set",
      verified: true,
    }));

    const editingText = await readFile(join(runDirectory, "editing-work-product.jsonl"), "utf8");
    expect(receipt.stageResults[1]!.output.output.digest.candidate).toBe(canonicalJsonlDigest(editingText));
    expect(receiptText).not.toContain("비공개 원문 sentinel");
    expect(receiptText).not.toContain("비공개 교정문 sentinel");

    const verified = runScript(verifierPath, ["1", evaluationRoot, "--cycle-dir", positionalCycle]);
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain("bound selection artifact");

    await Promise.all([
      rm(join(runDirectory, "workflow.sqlite3"), { force: true }),
      rm(join(runDirectory, "workflow.sqlite3-shm"), { force: true }),
      rm(join(runDirectory, "workflow.sqlite3-wal"), { force: true }),
    ]);
    const refused = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", positionalCycle]);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain(`refusing to overwrite ${join(runDirectory, "workflow-receipt.json")}`);
  });

  it("rejects a cycle work product changed after the receipt was recorded", async () => {
    const evaluationRoot = await createCycleFixture();
    const cycleDirectory = join("evals", "cycles", "0.1.0-rc2");
    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(recorded.status, recorded.stderr).toBe(0);

    const editingPath = join(evaluationRoot, cycleDirectory, "runs", "run-1", "editing-work-product.jsonl");
    const editingText = await readFile(editingPath, "utf8");
    await writeFile(editingPath, editingText.replace(`"candidateDigest":"${"c".repeat(64)}"`, `"candidateDigest":"${"e".repeat(64)}"`), "utf8");

    const verified = runScript(verifierPath, ["1", evaluationRoot, "--cycle-dir", cycleDirectory]);
    expect(verified.status).not.toBe(0);
    expect(verified.stderr).toContain("edit-candidate digest does not match its work product");
  });

  it("rejects a cycle directory outside the evaluation root", async () => {
    const evaluationRoot = await createCycleFixture();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "korean-prose-cycle-outside-"));
    temporaryDirectories.push(outsideDirectory);

    const recorded = runScript(recorderPath, ["1", evaluationRoot, "--cycle-dir", outsideDirectory]);
    expect(recorded.status).not.toBe(0);
    expect(recorded.stderr).toContain("cycle directory must be inside the evaluation root");
  });
});

async function createCycleFixture(): Promise<string> {
  const evaluationRoot = await mkdtemp(join(tmpdir(), "korean-prose-cycle-receipt-"));
  temporaryDirectories.push(evaluationRoot);
  const cycleDirectory = join(evaluationRoot, "evals", "cycles", "0.1.0-rc2");
  const runDirectory = join(cycleDirectory, "runs", "run-1");
  const rubricPath = join(evaluationRoot, "skills", "korean-prose-editor", "references", "verification-rubric.md");
  await mkdir(runDirectory, { recursive: true });
  await mkdir(dirname(rubricPath), { recursive: true });
  const files = new Map<string, string>([
    [join(cycleDirectory, "input.jsonl"), jsonl({ id: "case-1", sourceText: "비공개 원문 sentinel" })],
    [join(cycleDirectory, "manifest.json"), JSON.stringify({ schemaVersion: "1.0.0", cycleId: "0.1.0-rc2" })],
    [join(runDirectory, "selection-work-product.jsonl"), jsonl({
      schemaVersion: "1.0.0",
      actorId: actors[0],
      sourceDigest: "a".repeat(64),
      status: "ready",
      decisions: [{
        unitId: "unit-0001",
        action: "edit",
        reasonCodes: ["TRANSLATIONESE"],
        riskFlags: [],
        additionalProtectedStrings: [],
        issueRanges: [{ start: 0, end: 1, reasonCode: "TRANSLATIONESE" }],
      }],
    })],
    [join(runDirectory, "editing-work-product.jsonl"), jsonl({
      schemaVersion: "1.0.0",
      actorId: actors[1],
      sourceDigest: "a".repeat(64),
      selectionDigest: "b".repeat(64),
      edits: [{
        id: "edit-1",
        unitId: "unit-0001",
        sourceDigest: "a".repeat(64),
        start: 0,
        end: 1,
        replacement: "비공개 교정문 sentinel",
        actorId: actors[1],
      }],
      candidateDigest: "c".repeat(64),
    })],
    [join(runDirectory, "verification-work-product.jsonl"), jsonl({
      schemaVersion: "1.0.0",
      actorId: actors[2],
      sourceDigest: "a".repeat(64),
      editingDigest: "c".repeat(64),
      rubricDigest: "d".repeat(64),
      globalDecision: "continue",
      decisions: [{
        editId: "edit-1",
        decision: "accept",
        reasonCode: "MEANING_PRESERVED",
        sourceDefect: "TRANSLATIONESE",
        invariantDelta: "NONE",
      }],
      assessment: {
        meaningPreservation: "pass",
        majorMeaningChange: false,
        registerCompliance: "pass",
        protectedStrings: "pass",
        terminologyJudgment: "not-applicable",
        pairPreference: "candidate",
      },
    })],
    [join(runDirectory, "final.jsonl"), jsonl({
      id: "case-1",
      suite: "fixture",
      expectedDecision: "edit",
      candidateText: "비공개 교정문 sentinel",
      finalText: "비공개 교정문 sentinel",
      finalAction: "edit",
      selectedEdit: true,
      editResults: [{ editId: "edit-1", unitId: "unit-0001", decision: "accept", reasonCode: "VERIFIED" }],
      verification: { status: "verified" },
      protectedStrings: [],
    })],
    [join(runDirectory, "selection-meta.json"), JSON.stringify({ actorId: actors[0] })],
    [join(runDirectory, "editing-meta.json"), JSON.stringify({ actorId: actors[1] })],
    [join(runDirectory, "verification-meta.json"), JSON.stringify({ actorId: actors[2] })],
    [join(runDirectory, "metrics.json"), JSON.stringify({
      schemaVersion: "1.0.0",
      actorIds: actors,
      counts: { proposedEdits: 1, acceptedEdits: 1, retainedEdits: 0 },
    })],
    [rubricPath, "fixture rubric\n"],
  ]);
  await Promise.all([...files].map(([filename, contents]) => writeFile(filename, contents, "utf8")));
  return evaluationRoot;
}

function runScript(scriptPath: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function jsonl(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function canonicalJsonlDigest(text: string): string {
  const records = text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  return createHash("sha256").update(canonicalJson(records)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
