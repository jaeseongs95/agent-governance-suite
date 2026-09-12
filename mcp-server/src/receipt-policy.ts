import {
  CONTRACT_VERSION,
  ERROR_CODE,
  type PlannedStageV1,
  type StageResultV1,
  type WorkflowReceiptV1,
  WORKFLOW_STATE,
  WorkflowContractError,
} from "../../contracts/types.js";

const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REFERENCE = /^(?:artifact|digest|schema|urn|run|stage|commit|test|file|document|tool):(?:\/\/)?[A-Za-z0-9][A-Za-z0-9._~:/?#@!$&'()*+,;=%-]{7,}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const ERROR_DETAIL_KEYS = new Set([
  "actorId",
  "actorIdPointer",
  "actual",
  "artifactId",
  "artifactIds",
  "code",
  "conflictingStageId",
  "digest",
  "digests",
  "expected",
  "locator",
  "locators",
  "mode",
  "policy",
  "reference",
  "references",
  "runId",
  "schemaId",
  "stageId",
  "targetDigest",
]);

const PROTOCOL_TOKENS = new Set<string>([
  CONTRACT_VERSION,
  ...ERROR_CODE,
  ...WORKFLOW_STATE,
  "output",
  "adapter-error",
  "user-input",
  "file",
  "test",
  "document",
  "tool",
  "reference-only",
  "verified",
]);

function jsonPointer(value: unknown, pointer: string): unknown {
  return pointer.split("/").slice(1).reduce<unknown>((current, token) => {
    if (!current || typeof current !== "object") return undefined;
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    return (current as Record<string, unknown>)[key];
  }, value);
}

function isOpaqueReference(value: string): boolean {
  return DIGEST.test(value) || UUID.test(value) || REFERENCE.test(value);
}

function assertSafeString(value: string, fixedTokens: Set<string>, location: string, allowEmpty = false): void {
  if ((allowEmpty && value === "") || fixedTokens.has(value) || PROTOCOL_TOKENS.has(value) || isOpaqueReference(value)) return;
  throw new WorkflowContractError("INVALID_INPUT", "Reference-only receipt policy rejected free text.", {
    location,
  });
}

function assertSafeValue(value: unknown, fixedTokens: Set<string>, location: string): void {
  if (typeof value === "string") {
    assertSafeString(value, fixedTokens, location);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeValue(item, fixedTokens, `${location}/${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertSafeValue(item, fixedTokens, `${location}/${key}`);
    }
  }
}

function assertSafeError(
  error: StageResultV1["error"],
  fixedTokens: Set<string>,
  location: string,
): void {
  if (!error) return;
  assertSafeString(error.message, fixedTokens, `${location}/message`);
  if (error.details) {
    for (const [key, value] of Object.entries(error.details)) {
      if (!ERROR_DETAIL_KEYS.has(key)) {
        throw new WorkflowContractError("INVALID_INPUT", "Reference-only error details contain an undeclared field.", {
          location: `${location}/details/${key}`,
        });
      }
      assertSafeValue(value, fixedTokens, `${location}/details/${key}`);
    }
  }
}

/** Enforce descriptor-declared persistence policy before a stage result reaches a store. */
export function assertReceiptPolicy(
  receipt: WorkflowReceiptV1,
  stage: PlannedStageV1,
  result: StageResultV1,
  outputFixedTokens: Set<string>,
): void {
  const policy = stage.receiptPolicy;
  if (!policy) return;

  const fixedTokens = new Set([
    ...outputFixedTokens,
    ...stage.satisfiedCapabilities,
    ...stage.requiredInputArtifacts,
    ...stage.producedArtifacts,
    ...stage.requiredArtifacts,
  ]);
  assertSafeValue(result.output.output, fixedTokens, "/output/output");

  const allowedArtifacts = new Set([
    ...stage.requiredInputArtifacts,
    ...stage.producedArtifacts,
    ...stage.requiredArtifacts,
  ]);
  for (const [index, artifact] of result.output.artifacts.entries()) {
    if (!allowedArtifacts.has(artifact.artifactId)) {
      throw new WorkflowContractError("INVALID_INPUT", "Reference-only receipt contains an undeclared artifact.", {
        stageId: stage.stageId,
        artifactId: artifact.artifactId,
      });
    }
    assertSafeString(artifact.schemaId, fixedTokens, `/output/artifacts/${index}/schemaId`);
    assertSafeString(artifact.locator, fixedTokens, `/output/artifacts/${index}/locator`);
    if (!DIGEST.test(artifact.digest) || !DIGEST.test(artifact.targetDigest)) {
      throw new WorkflowContractError("INVALID_INPUT", "Reference-only artifact digests must be opaque SHA-256 references.", {
        stageId: stage.stageId,
        artifactId: artifact.artifactId,
      });
    }
  }

  for (const [index, evidence] of result.evidence.entries()) {
    if (!allowedArtifacts.has(evidence.artifactId)) {
      throw new WorkflowContractError("INVALID_INPUT", "Reference-only receipt contains undeclared evidence.", {
        stageId: stage.stageId,
        artifactId: evidence.artifactId,
      });
    }
    assertSafeString(evidence.locator, fixedTokens, `/evidence/${index}/locator`);
    assertSafeString(evidence.note, fixedTokens, `/evidence/${index}/note`, true);
  }
  result.findings.forEach((finding, index) => assertSafeString(finding, fixedTokens, `/findings/${index}`));
  result.blockers.forEach((blocker, index) => assertSafeString(blocker, fixedTokens, `/blockers/${index}`));
  assertSafeError(result.output.error, fixedTokens, "/output/error");
  assertSafeError(result.error, fixedTokens, "/error");

  const externalInputs = stage.requiredInputArtifacts.filter((artifactId) => !receipt.plan.stages.some(
    (candidate) => candidate.stageId !== stage.stageId && candidate.producedArtifacts.includes(artifactId),
  ));
  const missingExternalInputs = externalInputs.filter((artifactId) => !result.evidence.some(
    (evidence) => evidence.artifactId === artifactId && evidence.verified && isOpaqueReference(evidence.locator),
  ));
  if (missingExternalInputs.length > 0) {
    throw new WorkflowContractError("MISSING_EVIDENCE", "Reference-only stage prerequisites require verified artifact references.", {
      stageId: stage.stageId,
      missingInputs: missingExternalInputs,
    });
  }

  if (policy.actorIdsMatch === "prior-policy-actors" && policy.actorIdsPointer) {
    const priorActorStages = receipt.plan.stages
      .filter((candidate) => candidate.order < stage.order && candidate.receiptPolicy?.actorIdPointer)
      .sort((left, right) => left.order - right.order);
    const expectedActorIds = priorActorStages.map((priorStage) => {
      const priorResult = receipt.stageResults.find((candidate) => candidate.stageId === priorStage.stageId);
      const actorId = priorResult && jsonPointer(priorResult.output, priorStage.receiptPolicy!.actorIdPointer!);
      if (typeof actorId !== "string" || actorId === NIL_UUID || !UUID.test(actorId)) {
        throw new WorkflowContractError("MISSING_EVIDENCE", "A prior policy stage has no valid actor binding.", {
          stageId: stage.stageId,
          conflictingStageId: priorStage.stageId,
        });
      }
      return actorId;
    });
    const actorIds = jsonPointer(result.output, policy.actorIdsPointer);
    if (!Array.isArray(actorIds)
      || actorIds.length !== expectedActorIds.length
      || new Set(actorIds).size !== actorIds.length
      || actorIds.some((actorId, index) => actorId !== expectedActorIds[index])) {
      throw new WorkflowContractError("GATE_FAILED", "Receipt actor IDs must exactly match prior policy actors in plan order.", {
        stageId: stage.stageId,
        actorIdsPointer: policy.actorIdsPointer,
      });
    }
  }

  if (!policy.actorIdPointer) return;
  const actorId = jsonPointer(result.output, policy.actorIdPointer);
  if (typeof actorId !== "string" || actorId === NIL_UUID || !UUID.test(actorId)) {
    throw new WorkflowContractError("INVALID_INPUT", "Receipt actor ID must be a nonempty canonical lowercase UUID.", {
      stageId: stage.stageId,
      actorIdPointer: policy.actorIdPointer,
    });
  }
  if (policy.uniqueness !== "run") return;
  for (const priorResult of receipt.stageResults.filter((candidate) => candidate.stageId !== stage.stageId)) {
    const priorStage = receipt.plan.stages.find((candidate) => candidate.stageId === priorResult.stageId);
    if (!priorStage?.receiptPolicy?.actorIdPointer) continue;
    if (jsonPointer(priorResult.output, priorStage.receiptPolicy.actorIdPointer) === actorId) {
      throw new WorkflowContractError("GATE_FAILED", "Receipt actor ID must be unique across policy stages in this run.", {
        stageId: stage.stageId,
        conflictingStageId: priorStage.stageId,
      });
    }
  }
}
