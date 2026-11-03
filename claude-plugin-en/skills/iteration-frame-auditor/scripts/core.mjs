import { createHash } from "node:crypto";

import { hostText } from "../../../runtime/i18n.mjs";

import { validateComparisonSchema, validateRequestSchema, validateReviewSchema } from "./schema-validation.mjs";

export class InputError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "InputError";
    this.details = details;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new InputError(hostText("skillTools.iterationFrame.nonJsonValue"));
}

export function artifactDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function reviewRequestDigest(request) {
  return artifactDigest(request);
}

function schemaErrors(validator) {
  return structuredClone(validator.errors ?? []);
}

function requireDigest(actual, value, label) {
  if (actual !== artifactDigest(value)) throw new InputError(hostText("skillTools.iterationFrame.digestMismatch", { label }));
}

function requireKnownEvidence(refs, inventory, subject, id = "") {
  const known = new Set(inventory.map((item) => item.evidenceRef));
  for (const ref of refs) {
    if (!known.has(ref)) throw new InputError(hostText("skillTools.iterationFrame.unknownEvidence", { subject, id, ref }));
  }
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new InputError(hostText("skillTools.iterationFrame.duplicates", { label }));
}

export function validateRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new InputError(hostText("skillTools.iterationFrame.requestNotObject"));
  if (!validateRequestSchema(request)) {
    throw new InputError(hostText("skillTools.iterationFrame.requestSchemaFailed"), { errors: schemaErrors(validateRequestSchema) });
  }

  requireDigest(request.root.contractDigest, request.root.contract, "root.contractDigest");
  requireDigest(request.root.frameDigest, request.root.frame, "root.frameDigest");
  requireDigest(request.root.controlDigest, request.root.frame.controlArtifacts, "root.controlDigest");
  requireDigest(request.root.targetDigest, request.root.frame.targetArtifacts, "root.targetDigest");
  requireDigest(request.proposal.contractDigest, request.proposal.contract, "proposal.contractDigest");
  requireDigest(request.proposal.frameDigest, request.proposal.frame, "proposal.frameDigest");
  requireDigest(request.proposal.controlDigest, request.proposal.frame.controlArtifacts, "proposal.controlDigest");
  requireDigest(request.proposal.targetDigest, request.proposal.frame.targetArtifacts, "proposal.targetDigest");

  const evidenceIds = request.evidenceInventory.map((item) => item.evidenceRef);
  unique(evidenceIds, "evidenceInventory.evidenceRef");
  const requiredKinds = new Set(["contract-comparison", "control-comparison", "target-comparison", "reviewer-separation"]);
  if (request.attemptHistory.length > 0) requiredKinds.add("attempt-outcome");
  for (const item of request.evidenceInventory) requiredKinds.delete(item.kind);
  if (requiredKinds.size > 0) throw new InputError(hostText("skillTools.iterationFrame.missingEvidenceKinds", { kinds: [...requiredKinds].join(", ") }));

  const attemptIds = [];
  const sequenceKeys = [];
  const implementationActors = new Set();
  for (const attempt of request.attemptHistory) {
    attemptIds.push(attempt.attemptId);
    sequenceKeys.push(`${attempt.epoch}:${attempt.sequence}`);
    if (attempt.epoch > request.root.epoch) throw new InputError(hostText("skillTools.iterationFrame.futureEpoch", { attemptId: attempt.attemptId }));
    for (const actorId of attempt.implementationActorIds) implementationActors.add(actorId);
    requireKnownEvidence(attempt.evidenceRefs, request.evidenceInventory, "attempt", attempt.attemptId);
    if (!attempt.evidenceRefs.some((ref) => request.evidenceInventory.find((item) => item.evidenceRef === ref)?.kind === "attempt-outcome")) {
      throw new InputError(hostText("skillTools.iterationFrame.attemptNeedsOutcome", { attemptId: attempt.attemptId }));
    }
  }
  unique(attemptIds, "attemptHistory.attemptId");
  unique(sequenceKeys, "attemptHistory epoch/sequence");

  const assignedActors = new Set(request.reviewer.implementationActorIds);
  if (assignedActors.size !== implementationActors.size || [...implementationActors].some((actorId) => !assignedActors.has(actorId))) {
    throw new InputError(hostText("skillTools.iterationFrame.reviewerActorsMismatch"));
  }
  if (implementationActors.has(request.reviewer.actorId)) {
    throw new InputError(hostText("skillTools.iterationFrame.reviewerNotDistinct"));
  }
  requireKnownEvidence([request.reviewer.freshContextEvidenceRef], request.evidenceInventory, "reviewerAssignment");
  if (request.evidenceInventory.find((item) => item.evidenceRef === request.reviewer.freshContextEvidenceRef)?.kind !== "reviewer-separation") {
    throw new InputError(hostText("skillTools.iterationFrame.freshContextEvidenceKind"));
  }

  requireKnownEvidence(request.proposal.evidenceRefs, request.evidenceInventory, "proposal");
  const changedRoles = new Set(request.proposal.changeSummary.map((item) => item.claimedRole));
  const differences = [
    ["contract", request.root.contractDigest !== request.proposal.contractDigest],
    ["control", request.root.controlDigest !== request.proposal.controlDigest],
    ["target", request.root.targetDigest !== request.proposal.targetDigest]
  ];
  for (const [role, changed] of differences) {
    if (changed && !changedRoles.has(role) && !changedRoles.has("unknown")) {
      throw new InputError(hostText("skillTools.iterationFrame.changeSummaryMissing", { role }));
    }
  }
}

// The message is a catalog key rendered only on failure.
function push(errors, condition, key, params = {}) {
  if (!condition) errors.push(hostText(key, params));
}

function evidenceKindMatches(refs, kind, inventory) {
  const byId = new Map(inventory.map((item) => [item.evidenceRef, item]));
  return refs.some((ref) => byId.get(ref)?.kind === kind);
}

function checkComparisonShape(errors, comparison, expectedChanged, label) {
  const unchanged = comparison.impact === "unchanged";
  push(errors, unchanged === !expectedChanged, "skillTools.iterationFrame.impactConflictsEquality", { label });
  push(errors, unchanged ? comparison.changedPaths.length === 0 : comparison.changedPaths.length > 0, "skillTools.iterationFrame.changedPathsConflictsImpact", { label });
}

export function validateReview(review, comparison = null, request = null, frozenRequestArtifactDigest = null) {
  const errors = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) return [hostText("skillTools.iterationFrame.reviewNotObject")];
  if (!validateReviewSchema(review)) return [hostText("skillTools.iterationFrame.reviewSchemaFailed", { errors: JSON.stringify(schemaErrors(validateReviewSchema)) })];
  if (!comparison || typeof comparison !== "object" || Array.isArray(comparison)) return [hostText("skillTools.iterationFrame.comparisonRequired")];
  if (!validateComparisonSchema(comparison)) return [hostText("skillTools.iterationFrame.comparisonSchemaFailed", { errors: JSON.stringify(schemaErrors(validateComparisonSchema)) })];
  if (!request) errors.push(hostText("skillTools.iterationFrame.auditRequestRequired"));
  if (typeof frozenRequestArtifactDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(frozenRequestArtifactDigest)) {
    errors.push(hostText("skillTools.iterationFrame.frozenDigestRequired"));
  }
  if (!request) return errors;

  try {
    validateRequest(request);
  } catch (error) {
    // Only an input rejection becomes a review error; an internal failure propagates instead of posing as one.
    if (!(error instanceof InputError)) throw error;
    errors.push(hostText("skillTools.iterationFrame.requestCannotSubstantiate", { message: error.message }));
    if (error instanceof InputError && error.details) errors.push(hostText("skillTools.iterationFrame.requestValidationDetails", { details: JSON.stringify(error.details) }));
    return errors;
  }

  const computedRequestDigest = reviewRequestDigest(request);
  if (computedRequestDigest !== frozenRequestArtifactDigest) errors.push(hostText("skillTools.iterationFrame.requestDigestMismatch"));
  if (comparison.requestArtifactDigest !== frozenRequestArtifactDigest) errors.push(hostText("skillTools.iterationFrame.comparisonDigestMismatch"));
  if (review.rootId !== request.root.rootId) errors.push(hostText("skillTools.iterationFrame.reviewRootIdMismatch"));
  if (review.rootRevision !== request.root.revision) errors.push(hostText("skillTools.iterationFrame.reviewRootRevisionMismatch"));
  if (review.epoch !== request.root.epoch) errors.push(hostText("skillTools.iterationFrame.reviewEpochMismatch"));
  if (review.reviewerActorId !== request.reviewer.actorId) errors.push(hostText("skillTools.iterationFrame.reviewerActorMismatch"));
  if (review.freshContext.confirmed !== true) errors.push(hostText("skillTools.iterationFrame.freshContextNotConfirmed"));
  if (review.freshContext.evidenceRef !== request.reviewer.freshContextEvidenceRef) errors.push(hostText("skillTools.iterationFrame.freshContextEvidenceMismatch"));
  if (request.reviewer.implementationActorIds.includes(review.reviewerActorId)) errors.push(hostText("skillTools.iterationFrame.reviewerNotDistinctActors"));
  if (review.proposedFrame === null || artifactDigest(review.proposedFrame) !== request.proposal.frameDigest) errors.push(hostText("skillTools.iterationFrame.proposedFrameMismatch"));

  if (comparison.rootId !== request.root.rootId) errors.push(hostText("skillTools.iterationFrame.comparisonRootIdMismatch"));
  if (comparison.reviewedEpoch !== request.root.epoch) errors.push(hostText("skillTools.iterationFrame.comparisonEpochMismatch"));
  if (comparison.reviewer.actorId !== request.reviewer.actorId || comparison.reviewer.freshContext !== true) errors.push(hostText("skillTools.iterationFrame.comparisonReviewerMismatch"));

  const comparisons = comparison.comparisons;
  const contractChanged = request.root.contractDigest !== request.proposal.contractDigest;
  const controlChanged = request.root.controlDigest !== request.proposal.controlDigest;
  const targetChanged = request.root.targetDigest !== request.proposal.targetDigest;
  checkComparisonShape(errors, comparisons.contract, contractChanged, "comparisons.contract");
  checkComparisonShape(errors, comparisons.control, controlChanged, "comparisons.control");
  checkComparisonShape(errors, comparisons.target, targetChanged, "comparisons.target");

  if (contractChanged && comparisons.contract.impact !== "semantics-changing") {
    errors.push(hostText("skillTools.iterationFrame.contractMustBeSemantic"));
  }
  if (!controlChanged && comparisons.control.impact !== "unchanged") errors.push(hostText("skillTools.iterationFrame.controlMustBeUnchanged"));
  if (!targetChanged && comparisons.target.impact !== "unchanged") errors.push(hostText("skillTools.iterationFrame.targetMustBeUnchanged"));

  const inventory = request.evidenceInventory;
  const evidenceGroups = [
    [comparisons.contract.evidenceRefs, "contract-comparison", "contractComparison"],
    [comparisons.control.evidenceRefs, "control-comparison", "controlComparison"],
    [comparisons.target.evidenceRefs, "target-comparison", "targetComparison"]
  ];
  for (const [refs, kind, label] of evidenceGroups) {
    try {
      requireKnownEvidence(refs, inventory, label);
      if (!evidenceKindMatches(refs, kind, inventory)) errors.push(hostText("skillTools.iterationFrame.comparisonNeedsEvidenceKind", { subject: label, kind }));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [label, refs] of [
    ["review", review.evidenceRefs ?? []],
    ["comparison", comparison.evidenceRefs ?? []],
    ["rationale", (comparison.rationale ?? []).flatMap((item) => item.evidenceRefs ?? [])]
  ]) {
    try {
      requireKnownEvidence(refs, inventory, label);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (request.attemptHistory.length > 0 && !evidenceKindMatches(review.evidenceRefs ?? [], "attempt-outcome", inventory)) {
    errors.push(hostText("skillTools.iterationFrame.reviewNeedsAttemptOutcome"));
  }
  if (!evidenceKindMatches(review.evidenceRefs ?? [], "reviewer-separation", inventory)) errors.push(hostText("skillTools.iterationFrame.reviewNeedsSeparation"));
  for (const ref of comparison.evidenceRefs) {
    if (!review.evidenceRefs.includes(ref)) errors.push(hostText("skillTools.iterationFrame.reviewMissingComparisonEvidence", { ref }));
  }

  const unknownRole = request.proposal.changeSummary.some((item) => item.claimedRole === "unknown");
  const uncertain = unknownRole || comparisons.contract.impact === "uncertain" || comparisons.control.impact === "uncertain" || comparisons.target.impact === "uncertain";
  const semanticChange = comparisons.contract.impact === "semantics-changing" || comparisons.control.impact === "semantics-changing";

  if (uncertain) {
    push(errors, review.classification === "ambiguous", "skillTools.iterationFrame.uncertainNeedsAmbiguous");
    push(errors, review.comparability.comparable === false, "skillTools.iterationFrame.ambiguousNonComparable");
    push(errors, review.route === "panel", "skillTools.iterationFrame.ambiguousRoutePanel");
  } else if (semanticChange) {
    push(errors, review.classification === "semantics-changing", "skillTools.iterationFrame.semanticNeedsClassification");
    push(errors, review.comparability.comparable === false, "skillTools.iterationFrame.semanticNonComparable");
    push(errors, review.route === "needs-user", "skillTools.iterationFrame.semanticRouteNeedsUser");
  } else {
    push(errors, review.classification === "semantics-preserving", "skillTools.iterationFrame.stableNeedsPreserving");
    push(errors, review.comparability.comparable === true, "skillTools.iterationFrame.preservingComparable");
    const allowedRoutes = targetChanged ? ["resume-new-epoch", "diagnose", "stop"] : ["diagnose", "stop"];
    push(errors, allowedRoutes.includes(review.route), "skillTools.iterationFrame.incompatibleRoute", { targetState: targetChanged ? "changed" : "unchanged" });
  }

  if (review.route === "resume-new-epoch") {
    push(errors, targetChanged, "skillTools.iterationFrame.resumeNeedsTargetChange");
    push(errors, comparisons.target.impact === "changed", "skillTools.iterationFrame.resumeNeedsImpactChanged");
  }
  return errors;
}
