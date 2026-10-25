import path from "node:path";

import { type PlannedStageV1, type Sha256Digest, type StageResultV1, WorkflowContractError } from "../../contracts/types.js";
import { validateReportAgainstRequest } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";
import { validateSemantics as validateSecurityAudit } from "../../skills/software-security-auditor/scripts/core.mjs";
import { convergenceDigest } from "./convergence-logic.js";
import { loadStageOutputFile } from "./stage-output-file.js";

/** What a provider semantic validator may rely on: the signed stage, the recorded result and its provider output. */
export interface ProviderSemanticContext {
  taskId: string;
  taskDigest: string | undefined;
  stage: PlannedStageV1;
  result: StageResultV1;
  output: Record<string, unknown>;
}

interface ProviderSemanticValidator {
  message: string;
  /** Returns the skill validator's own errors; binding failures throw with their own code. */
  validate(context: ProviderSemanticContext): string[];
}

const ACCEPTANCE_REQUEST_ARTIFACT = "acceptance-evidence-request";

function sha256Form(digest: string): Sha256Digest {
  return (digest.startsWith("sha256:") ? digest : `sha256:${digest}`) as Sha256Digest;
}

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * Runs the skill's canonical report validator against the frozen request the stage recorded, then binds that
 * request to this task and to the target the signed plan declared, so a self-consistent report about another
 * target or another request cannot pass.
 */
function acceptanceEvidenceSemantics({ taskId, taskDigest, stage, result, output }: ProviderSemanticContext): string[] {
  if (!taskDigest) {
    throw new WorkflowContractError("BINDING_REQUIRED", "Acceptance evidence verification requires a signed task digest.", { stageId: stage.stageId });
  }
  const references = result.output.artifacts.filter((artifact) => artifact.artifactId === ACCEPTANCE_REQUEST_ARTIFACT);
  const reference = references[0];
  if (references.length !== 1 || !reference?.verified || !path.isAbsolute(reference.locator)
    || /^(?:\\\\|\/\/)/u.test(reference.locator)) {
    throw new WorkflowContractError("MISSING_EVIDENCE", "An acceptance evidence report requires one verified local acceptance-evidence-request artifact.", {
      stageId: stage.stageId,
      artifactId: ACCEPTANCE_REQUEST_ARTIFACT,
    });
  }
  const request = loadStageOutputFile({ locator: reference.locator, digest: sha256Form(reference.digest) });
  const errors = validateReportAgainstRequest(output, request);
  if (errors.length > 0) return errors;
  const requestTarget = field(request.target, "digest");
  const requestTaskId = field(request.taskEnvelope, "taskId");
  const requestTaskDigest = convergenceDigest(request.taskEnvelope);
  const declaredTargets = (stage.artifactContract?.produced ?? []).map((item) => item.targetDigest);
  if (
    requestTaskId !== taskId
    || requestTaskDigest !== taskDigest
    || requestTarget !== sha256Form(reference.targetDigest)
    || declaredTargets.some((declared) => declared !== requestTarget)
  ) {
    throw new WorkflowContractError("BINDING_INVALID", "The frozen acceptance request is not bound to this task and the signed plan target.", {
      stageId: stage.stageId,
      taskBound: requestTaskId === taskId && requestTaskDigest === taskDigest,
      requestTarget: typeof requestTarget === "string" ? requestTarget : null,
      declaredTargets,
    });
  }
  return [];
}

/**
 * Skill-owned semantic validators, keyed by the name a descriptor declares as its gate validator or by the
 * capability it supplies. Each entry calls the skill's own script; the server does not re-implement it.
 */
const PROVIDER_SEMANTIC_VALIDATORS: Readonly<Record<string, ProviderSemanticValidator>> = {
  "software-security-audit": {
    message: "Security audit report is inconsistent.",
    validate: ({ output }) => validateSecurityAudit(output),
  },
  "acceptance-evidence-validation": {
    message: "Acceptance evidence report is inconsistent.",
    validate: acceptanceEvidenceSemantics,
  },
};

export function assertProviderSemantics(
  context: Omit<ProviderSemanticContext, "output"> & { output: Record<string, unknown> | null },
): void {
  const { stage } = context;
  const names = new Set([stage.gate.validator, stage.requiredCapability, ...stage.satisfiedCapabilities]
    .filter((name): name is string => typeof name === "string" && Object.hasOwn(PROVIDER_SEMANTIC_VALIDATORS, name)));
  for (const name of names) {
    const validator = PROVIDER_SEMANTIC_VALIDATORS[name]!;
    if (context.output === null) {
      throw new WorkflowContractError("INVALID_INPUT", `${validator.message} The provider output is missing.`, {
        stageId: stage.stageId,
        validator: name,
      });
    }
    const errors = validator.validate({ ...context, output: context.output });
    if (errors.length > 0) {
      throw new WorkflowContractError("INVALID_INPUT", validator.message, { stageId: stage.stageId, validator: name, errors });
    }
  }
}
