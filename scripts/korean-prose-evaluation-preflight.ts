import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

import {
  assertEvaluationPreflight,
  EvaluationPreflightError,
  type EvaluationActorSpec,
  type EvaluationArtifactSpec,
  type EvaluationDigestBinding,
  type EvaluationPreflightResult,
  type EvaluationRecordBinding,
} from "../mcp-server/src/evaluation-preflight.js";
import {
  evaluateKoreanProseReadiness,
  digestCanonical,
  exists,
  type KoreanProseReadinessResult,
} from "./korean-prose-readiness.js";
import { assertConcreteKoreanProseExecutionProvenance } from "./korean-prose-execution-provenance.js";

export type KoreanProseEvaluationPhase = "selection" | "editing" | "verification" | "record";

// Every later phase may still write only a tail of the outputs pending before selection, in this order.
const STRUCTURED_OUTPUTS = [
  "selection-work-product.jsonl", "selection-meta.json", "editing-work-product.jsonl", "editing-meta.json",
  "verification-work-product.jsonl", "verification-meta.json", "final.jsonl", "metrics.json",
  "workflow.sqlite3", "workflow-receipt.json", "receipt-binding.json", "evaluation-run-claim.json",
];
const LEGACY_OUTPUTS = [
  "selection.jsonl", "selection-meta.json", "candidate.jsonl", "editing-meta.json",
  "verification-input.jsonl", "verification-input-meta.json", "verification.jsonl", "verification-meta.json",
  "final.jsonl", "metrics.json", "workflow.sqlite3", "workflow-receipt.json",
];

export async function preflightStructuredKoreanProseEvaluation(
  phase: KoreanProseEvaluationPhase,
  run: number,
  cycleDirectory: string,
  expectedFrameDigest: string,
  expectedValidityReportDigest: string,
  evaluationRoot: string,
): Promise<KoreanProseReadinessResult> {
  const cycleRoot = await realpath(cycleDirectory);
  const readiness = await evaluateKoreanProseReadiness(cycleRoot, {
    requireQuality: false,
    expectedFrameDigest,
    expectedValidityReportDigest,
    evaluationRoot,
  });
  if (!Number.isInteger(run) || run < 1 || run > readiness.runBudget) {
    throw new Error(`run ${run} exceeds the frozen run budget ${readiness.runBudget}`);
  }
  const runDirectory = path.join(cycleRoot, "runs", `run-${run}`);
  const pending = {
    selection: STRUCTURED_OUTPUTS,
    editing: STRUCTURED_OUTPUTS.slice(2, 11),
    verification: STRUCTURED_OUTPUTS.slice(4, 11),
    record: STRUCTURED_OUTPUTS.slice(8, 11),
  } satisfies Record<KoreanProseEvaluationPhase, string[]>;
  for (const name of pending[phase]) {
    if (await exists(path.join(runDirectory, name))) {
      throw new Error(`refusing to overwrite ${path.join(runDirectory, name)}`);
    }
  }
  const qualityPath = path.join(cycleRoot, "quality-report.json");
  if (await exists(qualityPath)) {
    throw new Error(`refusing to overwrite ${qualityPath}`);
  }
  const claimPath = path.join(runDirectory, "evaluation-run-claim.json");
  if (phase === "selection") {
    await assertStructuredPhaseInputs(phase, run, cycleRoot, readiness.caseCount, readiness.rubricDigest);
    await mkdir(runDirectory, { recursive: true });
    await writeFile(claimPath, `${JSON.stringify({
      schemaVersion: "1.0.0",
      frameId: readiness.frameId,
      frameDigest: readiness.frameDigest,
      validityReportDigest: expectedValidityReportDigest,
      run,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } else {
    const claim = await readJson(claimPath);
    if (claim.schemaVersion !== "1.0.0" || claim.frameId !== readiness.frameId
      || claim.frameDigest !== readiness.frameDigest || claim.validityReportDigest !== expectedValidityReportDigest
      || claim.run !== run || typeof claim.startedAt !== "string" || !Number.isFinite(Date.parse(claim.startedAt))) {
      throw new Error("structured evaluation run does not have a matching atomic start claim");
    }
    await assertStructuredPhaseInputs(phase, run, cycleRoot, readiness.caseCount, readiness.rubricDigest);
  }
  return readiness;
}

let workProductValidators: Promise<Record<"selection" | "editing" | "verification", ValidateFunction>> | null = null;

async function assertStructuredPhaseInputs(
  phase: KoreanProseEvaluationPhase,
  run: number,
  cycleRoot: string,
  caseCount: number,
  rubricDigest: string,
): Promise<void> {
  if (phase === "selection") return;
  const inputRecords = parseStructuredJsonl(await readFile(path.join(cycleRoot, "input.jsonl"), "utf8"));
  const runDirectory = path.join(cycleRoot, "runs", `run-${run}`);
  const startClaimSha256 = createHash("sha256")
    .update(await readFile(path.join(runDirectory, "evaluation-run-claim.json")))
    .digest("hex");
  const validators = await loadWorkProductValidators();
  const roles = phase === "editing" ? ["selection"] as const
    : phase === "verification" ? ["selection", "editing"] as const
    : ["selection", "editing", "verification"] as const;
  const recordsByRole = new Map<string, Array<Record<string, unknown>>>();
  const actors: string[] = [];
  for (const role of roles) {
    const filename = `${role}-work-product.jsonl`;
    const text = await readFile(path.join(runDirectory, filename), "utf8");
    const records = parseStructuredJsonl(text);
    if (records.length !== caseCount) throw new Error(`${role} work product case count does not match the frozen frame`);
    for (const record of records) {
      if (!validators[role](record)) throw new Error(`${role} work product does not satisfy its schema: ${JSON.stringify(validators[role].errors)}`);
    }
    const actorIds = new Set(records.map((record) => requiredStructuredString(record, "actorId", role)));
    if (actorIds.size !== 1) throw new Error(`${role} work product uses inconsistent actors`);
    const actorId = [...actorIds][0]!;
    actors.push(actorId);
    for (const [index, record] of records.entries()) {
      const sourceText = requiredStructuredString(inputRecords[index]!, "sourceText", "input");
      if (record.sourceDigest !== sha256Text(sourceText)) throw new Error(`${role} work product source digest mismatch at case ${index + 1}`);
      if (role === "editing") {
        const selection = recordsByRole.get("selection")![index]!;
        if (record.selectionDigest !== digestCanonical(selection).slice("sha256:".length)) throw new Error("editing work product selection digest mismatch");
        const edits = record.edits as Array<Record<string, unknown>>;
        if (edits.some((edit) => edit.actorId !== actorId)) throw new Error("editing work product edit actor mismatch");
      }
      if (role === "verification") {
        const editing = recordsByRole.get("editing")![index]!;
        if (record.editingDigest !== digestCanonical(editing).slice("sha256:".length)) throw new Error("verification work product editing digest mismatch");
        if (record.rubricDigest !== rubricDigest.slice("sha256:".length)) throw new Error("verification work product rubric digest mismatch");
      }
    }
    const meta = await readJson(path.join(runDirectory, `${role}-meta.json`));
    assertStructuredRoleMeta(meta, role, actorId, run, caseCount, digestCanonical(inputRecords).slice("sha256:".length),
      digestCanonical(records).slice("sha256:".length), startClaimSha256);
    recordsByRole.set(role, records);
  }
  if (new Set(actors).size !== actors.length) throw new Error("structured evaluation reuses a language actor across roles");
}

async function loadWorkProductValidators(): Promise<Record<"selection" | "editing" | "verification", ValidateFunction>> {
  workProductValidators ??= (async () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    const root = path.resolve(import.meta.dirname, "..", "skills", "korean-prose-editor", "contracts");
    const [glossaryBinding, selection, editing, verification] = await Promise.all([
      readJson(path.join(root, "glossary-binding.v1.schema.json")),
      readJson(path.join(root, "selection-work-product.v1.schema.json")),
      readJson(path.join(root, "editing-work-product.v1.schema.json")),
      readJson(path.join(root, "verification-work-product.v1.schema.json")),
    ]);
    ajv.addSchema(glossaryBinding);
    return { selection: ajv.compile(selection), editing: ajv.compile(editing), verification: ajv.compile(verification) };
  })();
  return workProductValidators;
}

function assertStructuredRoleMeta(
  meta: Record<string, unknown>, role: string, actorId: string, run: number, caseCount: number,
  inputSha256: string, workProductSha256: string,
  startClaimSha256: string,
): void {
  if (meta.schemaVersion !== "3.0.0" || meta.role !== role || meta.actorId !== actorId || meta.run !== run
    || meta.caseCount !== caseCount || meta.inputSha256 !== inputSha256 || meta.workProductSha256 !== workProductSha256
    || meta.status !== "complete" || meta.startClaimSha256 !== startClaimSha256
    || !meta.executionProvenance || typeof meta.executionProvenance !== "object") {
    throw new Error(`${role} metadata is not bound to the frozen structured work product`);
  }
  assertConcreteKoreanProseExecutionProvenance(meta.executionProvenance, role);
}

function parseStructuredJsonl(text: string): Array<Record<string, unknown>> {
  const records = text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as unknown);
  if (records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) throw new Error("structured artifact must contain JSON objects");
  return records as Array<Record<string, unknown>>;
}

function requiredStructuredString(record: Record<string, unknown>, field: string, label: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} record is missing ${field}`);
  return value;
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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
    selection: LEGACY_OUTPUTS,
    editing: LEGACY_OUTPUTS.slice(2),
    verification: LEGACY_OUTPUTS.slice(6),
    record: LEGACY_OUTPUTS.slice(10),
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
