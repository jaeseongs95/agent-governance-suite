import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  assertEvaluationPreflight,
  EvaluationPreflightError,
  type EvaluationActorSpec,
  type EvaluationArtifactSpec,
  type EvaluationDigestBinding,
  type EvaluationPreflightResult,
  type EvaluationRecordBinding,
} from "../mcp-server/src/evaluation-preflight.js";

export type KoreanProseEvaluationPhase = "selection" | "editing" | "verification" | "record";

interface EvaluationManifest {
  caseCount: number;
  inputSha256: string;
  runCount: number;
}

export async function preflightKoreanProseEvaluation(
  phase: KoreanProseEvaluationPhase,
  run: number,
  evaluationRoot: string,
): Promise<EvaluationPreflightResult> {
  const root = path.resolve(evaluationRoot);
  const runsRoot = path.join(root, "evals", "runs");
  const runDirectory = path.join(runsRoot, `run-${run}`);
  const manifest = asManifest(await readJson(path.join(runsRoot, "manifest.json")));
  const inputText = await readFile(path.join(runsRoot, "input.jsonl"), "utf8");
  const artifacts: EvaluationArtifactSpec[] = [{
    name: "input",
    text: inputText,
    canonicalIds: true,
    idField: "id",
    requiredFields: ["id", "sourceText"],
    nonEmptyStringFields: ["sourceText"],
    forbiddenVisibleFields: ["expectedDecision"],
  }];
  const actors: EvaluationActorSpec[] = [];
  const digestBindings: EvaluationDigestBinding[] = [{
    name: "input",
    value: inputText,
    expectedSha256: manifest.inputSha256,
  }];
  const recordBindings: EvaluationRecordBinding[] = [];

  if (phase !== "selection") {
    const selectionText = await readFile(path.join(runDirectory, "selection.jsonl"), "utf8");
    const selectionMeta = await readJson(path.join(runDirectory, "selection-meta.json"));
    assertRoleMeta(selectionMeta, "selection", run, manifest.caseCount);
    const selectionActorId = stringField(selectionMeta, "actorId", "ACTOR_BINDING_MISMATCH");
    actors.push({ role: "selection", actorId: selectionActorId, declaredActorId: selectionActorId });
    artifacts.push({
      name: "selection",
      text: selectionText,
      idField: "id",
      requiredFields: ["id", "actorId", "action"],
      actorRole: "selection",
    });
    digestBindings.push({
      name: "selection-input",
      value: inputText,
      expectedSha256: stringField(selectionMeta, "inputSha256", "DIGEST_MISMATCH"),
    });
  }

  if (phase === "verification" || phase === "record") {
    const [candidateText, verificationInputText, verificationInputMeta] = await Promise.all([
      readFile(path.join(runDirectory, "candidate.jsonl"), "utf8"),
      readFile(path.join(runDirectory, "verification-input.jsonl"), "utf8"),
      readJson(path.join(runDirectory, "verification-input-meta.json")),
    ]);
    const editingMeta = await readJson(path.join(runDirectory, "editing-meta.json"));
    assertRoleMeta(editingMeta, "editing", run, manifest.caseCount);
    const editingActorId = stringField(editingMeta, "actorId", "ACTOR_BINDING_MISMATCH");
    const selectorActorId = stringField(editingMeta, "selectorActorId", "ACTOR_BINDING_MISMATCH");
    if (selectorActorId !== actors.find((actor) => actor.role === "selection")?.actorId) {
      throw new EvaluationPreflightError("ACTOR_BINDING_MISMATCH", "editing metadata does not bind the selection actor", {
        selectorActorId,
      });
    }
    actors.push({ role: "editing", actorId: editingActorId, declaredActorId: editingActorId });
    artifacts.push({
      name: "candidate",
      text: candidateText,
      idField: "id",
      requiredFields: ["id", "actorId", "candidateText"],
      nonEmptyStringFields: ["candidateText"],
      actorRole: "editing",
    });
    artifacts.push({
      name: "verification-input",
      text: verificationInputText,
      idField: "id",
      requiredFields: ["id", "sourceText", "candidateText"],
      nonEmptyStringFields: ["sourceText", "candidateText"],
      forbiddenVisibleFields: [
        "expectedDecision",
        "editorRationale",
        "reasonCodes",
        "riskFlags",
        "selectionAction",
        "actorId",
        "finalDecision",
      ],
    });
    assertFrozenVerificationInput(verificationInputMeta, run, manifest.caseCount);
    digestBindings.push(
      {
        name: "editing-input",
        value: inputText,
        expectedSha256: stringField(editingMeta, "inputSha256", "DIGEST_MISMATCH"),
      },
      {
        name: "verification-input",
        value: verificationInputText,
        expectedSha256: stringField(verificationInputMeta, "sha256", "DIGEST_MISMATCH"),
      },
    );
    recordBindings.push(
      { sourceArtifact: "input", targetArtifact: "verification-input", fields: ["sourceText"] },
      { sourceArtifact: "candidate", targetArtifact: "verification-input", fields: ["candidateText"] },
    );
    const rubricText = await readFile(path.join(root, "skills", "korean-prose-editor", "references", "verification-rubric.md"));
    digestBindings.push({ name: "candidate", value: candidateText }, { name: "rubric", value: rubricText });
  }

  if (phase === "record") {
    const [verificationText, finalText, verificationMeta] = await Promise.all([
      readFile(path.join(runDirectory, "verification.jsonl"), "utf8"),
      readFile(path.join(runDirectory, "final.jsonl"), "utf8"),
      readJson(path.join(runDirectory, "verification-meta.json")),
    ]);
    assertRoleMeta(verificationMeta, "verification", run, manifest.caseCount, false);
    const verificationActorId = stringField(verificationMeta, "actorId", "ACTOR_BINDING_MISMATCH");
    actors.push({ role: "verification", actorId: verificationActorId, declaredActorId: verificationActorId });
    artifacts.push({
      name: "verification",
      text: verificationText,
      idField: "id",
      requiredFields: ["id", "actorId", "finalDecision"],
      actorRole: "verification",
    });
    artifacts.push({
      name: "final",
      text: finalText,
      idField: "id",
      requiredFields: ["id", "finalText", "finalAction"],
      nonEmptyStringFields: ["finalText"],
    });
    const verificationInputText = artifacts.find((artifact) => artifact.name === "verification-input")!.text;
    digestBindings.push(
      {
        name: "verification-meta-input",
        value: verificationInputText,
        expectedSha256: stringField(verificationMeta, "verificationInputSha256", "DIGEST_MISMATCH"),
      },
      {
        name: "rubric",
        value: await readFile(path.join(root, "skills", "korean-prose-editor", "references", "verification-rubric.md")),
        expectedSha256: stringField(verificationMeta, "rubricSha256", "DIGEST_MISMATCH"),
      },
    );
  }

  return assertEvaluationPreflight({
    runOrdinal: run,
    approvedRunCount: manifest.runCount,
    expectedRecordCount: manifest.caseCount,
    outputPaths: pendingOutputPaths(phase, runDirectory),
    actors,
    artifacts,
    digestBindings,
    recordBindings,
  });
}

function pendingOutputPaths(phase: KoreanProseEvaluationPhase, runDirectory: string): string[] {
  const outputs = {
    selection: [
      "selection.jsonl",
      "selection-meta.json",
      "candidate.jsonl",
      "editing-meta.json",
      "verification-input.jsonl",
      "verification-input-meta.json",
      "verification.jsonl",
      "verification-meta.json",
      "final.jsonl",
      "metrics.json",
      "workflow.sqlite3",
      "workflow-receipt.json",
    ],
    editing: [
      "candidate.jsonl",
      "editing-meta.json",
      "verification-input.jsonl",
      "verification-input-meta.json",
      "verification.jsonl",
      "verification-meta.json",
      "final.jsonl",
      "metrics.json",
      "workflow.sqlite3",
      "workflow-receipt.json",
    ],
    verification: [
      "verification.jsonl",
      "verification-meta.json",
      "final.jsonl",
      "metrics.json",
      "workflow.sqlite3",
      "workflow-receipt.json",
    ],
    record: ["workflow.sqlite3", "workflow-receipt.json"],
  } satisfies Record<KoreanProseEvaluationPhase, string[]>;
  return outputs[phase].map((name) => path.join(runDirectory, name));
}

function assertRoleMeta(
  meta: Record<string, unknown>,
  role: string,
  run: number,
  caseCount: number,
  requireRun = true,
): void {
  if (
    meta.role !== role
    || meta.caseCount !== caseCount
    || (requireRun && meta.run !== run)
    || (requireRun && meta.status !== "complete")
  ) {
    throw new EvaluationPreflightError("ACTOR_BINDING_MISMATCH", "role metadata does not match the frozen run", {
      role,
      run,
      caseCount,
    });
  }
}

function assertFrozenVerificationInput(meta: Record<string, unknown>, run: number, caseCount: number): void {
  if (
    meta.run !== run
    || meta.caseCount !== caseCount
    || meta.status !== "frozen"
    || meta.containsExpectedDecision !== false
    || meta.containsEditorRationale !== false
  ) {
    throw new EvaluationPreflightError("FORBIDDEN_VISIBLE_FIELD", "verification input metadata is not frozen and blind", {
      run,
      caseCount,
    });
  }
}

function asManifest(value: Record<string, unknown>): EvaluationManifest {
  if (
    !Number.isInteger(value.caseCount)
    || !Number.isInteger(value.runCount)
    || typeof value.inputSha256 !== "string"
  ) {
    throw new EvaluationPreflightError("DIGEST_MISMATCH", "evaluation manifest is missing frozen run metadata");
  }
  return {
    caseCount: value.caseCount as number,
    inputSha256: value.inputSha256,
    runCount: value.runCount as number,
  };
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  code: "ACTOR_BINDING_MISMATCH" | "DIGEST_MISMATCH",
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new EvaluationPreflightError(code, "required evaluation metadata field is missing", { field });
  }
  return fieldValue;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    throw new EvaluationPreflightError("INVALID_JSONL", "evaluation metadata is not valid JSON", {
      file,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvaluationPreflightError("INVALID_JSONL", "evaluation metadata must be a JSON object", { file });
  }
  return value as Record<string, unknown>;
}
