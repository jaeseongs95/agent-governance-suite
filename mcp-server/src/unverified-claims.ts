import type {
  PlannedStageV1,
  WorkflowPlanV1,
  StageResultV1,
  UnverifiedClaim,
  UnverifiedClaimV1,
} from "../../contracts/types.js";
import type { ConvergenceSnapshot } from "./workflow-store.js";

/**
 * Properties a passed stage relies on that AGS did not observe. Actor separation is observed only when the
 * checker and every implementer were host-observed (caller-actor.ts independence); otherwise the record says
 * so instead of presenting the root's declaration as verified.
 */
export function stageUnverifiedClaims(
  stage: PlannedStageV1,
  result: StageResultV1,
  executionObserved: boolean,
  externalInputs: string[],
  independenceVerified = false,
): UnverifiedClaimV1[] {
  if (result.state !== "passed") return [];
  const claims: UnverifiedClaim[] = [];
  if (stage.riskGate === "mandatory" && stage.requiredArtifacts.includes("gate-verdict")) {
    if (!independenceVerified) claims.push("actor-independence", "no-redelegation");
    claims.push("fresh-context", "worker-execution-profile");
    if (stage.requiredAuditPhase === "post-execution" || stage.requiredAuditPhase === "post-deploy") claims.push("post-execution-state");
  }
  if (stage.satisfiedCapabilities.includes("iteration-frame-audit")) {
    if (!independenceVerified) claims.push("actor-independence");
    claims.push("fresh-context", "worker-execution-profile");
  }
  if (stage.requiredArtifacts.includes("decision-record")) {
    claims.push("panel-independence", "worker-execution-profile");
    const proposal = (result.output.output?.decisionRecord as { consensus_proposal?: { status?: unknown } } | undefined)?.consensus_proposal;
    if (proposal?.status === "conditional_consensus") claims.push("conditions-verified");
  }
  if (stage.receiptPolicy?.actorIdPointer || stage.receiptPolicy?.actorIdsPointer) claims.push("actor-independence");
  if (stage.executionRequirement?.kind === "semantic" && result.executionContext && !executionObserved) claims.push("execution-profile");

  const entries: UnverifiedClaimV1[] = claims.map((claim) => ({ stageId: stage.stageId, claim }));
  const matched = new Set((result.artifactChecks ?? [])
    .filter((item) => item.check === "sha256-matched")
    .map((item) => item.artifactId));
  const required = [...stage.requiredArtifacts, ...externalInputs];
  for (const artifactId of [...new Set(required)]) {
    if (!matched.has(artifactId)) entries.push({ stageId: stage.stageId, claim: "evidence-content", artifactId });
  }
  return unique(entries);
}

/** Root-level properties a convergence lineage relies on that AGS did not observe. */
export function convergenceUnverifiedClaims(snapshot: Pick<ConvergenceSnapshot, "root" | "reviews" | "leases">): UnverifiedClaimV1[] {
  const entries: UnverifiedClaimV1[] = [];
  if (snapshot.root.parentRootId) entries.push({ stageId: null, claim: "user-approval" });
  if (snapshot.reviews.some((review) => review.observedReviewer?.independence !== "verified")) {
    entries.push({ stageId: null, claim: "reviewer-independence" });
  }
  if (snapshot.reviews.length > 0) entries.push({ stageId: null, claim: "fresh-context" });
  if (snapshot.leases.some((lease) => (lease.priorEvidenceDigests ?? []).length > 0)) entries.push({ stageId: null, claim: "evidence-relevance" });
  return entries;
}

export function unique(entries: UnverifiedClaimV1[]): UnverifiedClaimV1[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.stageId ?? ""}\0${entry.claim}\0${entry.artifactId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Required inputs no other planned stage produces; they come from outside the run. */
export function externalInputs(plan: WorkflowPlanV1, stage: PlannedStageV1): string[] {
  return stage.requiredInputArtifacts.filter((artifactId) => !plan.stages.some(
    (candidate) => candidate.stageId !== stage.stageId && candidate.producedArtifacts.includes(artifactId),
  ));
}
