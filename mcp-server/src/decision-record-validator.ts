import { isDeepStrictEqual } from "node:util";

type JsonObject = Record<string, unknown>;

const EVIDENCE_STATUSES = new Set(["verified", "unverified", "refuted", "not_observable"]);
const ISSUE_STATUSES = new Set(["CONFIRMED", "REFUTED", "PARTIALLY_SUPPORTED", "UNRESOLVED", "NOT_OBSERVABLE"]);
const FORBIDDEN_KEYS = new Set([
  "chain_of_thought",
  "raw_reasoning",
  "internal_prompt",
  "system_prompt",
  "execution_directive",
  "tool_directive",
]);

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringArray(value: unknown): string[] {
  return array(value).filter((item): item is string => typeof item === "string");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameValues(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function duplicateFree(values: string[]): boolean {
  return values.length === new Set(values).size;
}

/** Mirrors the canonical v1 Python validator's cross-field invariants. */
export function validateDecisionRecordSemantics(record: JsonObject): string[] {
  const errors: string[] = [];
  const preflight = object(record.preflight);
  const requiredCapabilities = stringArray(preflight.required_capabilities);
  const observedCapabilities = stringArray(preflight.observed_capabilities);
  const missingCapabilities = stringArray(preflight.missing_capabilities);
  if (
    !duplicateFree(requiredCapabilities)
    || !duplicateFree(observedCapabilities)
    || !duplicateFree(missingCapabilities)
    || requiredCapabilities.some((value) => !nonempty(value))
    || observedCapabilities.some((value) => !nonempty(value))
    || missingCapabilities.some((value) => !nonempty(value))
  ) {
    errors.push("preflight capabilities must be unique nonempty strings");
  }
  const requiredSet = new Set(requiredCapabilities);
  const observedSet = new Set(observedCapabilities);
  const expectedMissing = new Set([...requiredSet].filter((value) => !observedSet.has(value)));
  const missingSet = new Set(missingCapabilities);
  if (!sameValues(expectedMissing, missingSet)) {
    errors.push("preflight missing capabilities must exactly equal required minus observed");
  }

  const caseBrief = object(record.case_brief);
  if (!isDeepStrictEqual(caseBrief.constraints, record.constraints)) {
    errors.push("case_brief constraints must match record constraints");
  }

  const run = object(record.run);
  const stage = run.stage;
  const assurance = run.assurance;
  const cap = run.worker_cap;
  const strictShortfall = run.strict === true && run.capability_shortfall === true;
  if (run.capability_shortfall !== (missingSet.size > 0)) {
    errors.push("run capability_shortfall must match preflight missing capabilities");
  }

  const workers = array(run.workers).map(object);
  const workerById = new Map<string, JsonObject>();
  for (const worker of workers) {
    const id = worker.id;
    if (!nonempty(id) || workerById.has(id)) {
      errors.push("worker ids must be unique nonempty strings");
    } else {
      workerById.set(id, worker);
    }
  }
  const manifest = array(record.panel_manifest);
  if (!isDeepStrictEqual(manifest, array(run.workers))) {
    errors.push("panel_manifest must exactly equal run.workers");
  }
  const instantiated = new Set([...workerById].filter(([, worker]) => worker.instantiated === true).map(([id]) => id));
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0 || cap > 8 || instantiated.size > cap) {
    errors.push("worker cap exceeded or invalid");
  }

  const participated = (worker: JsonObject): string[] => stringArray(worker.participated_stages);
  const eligibleReviewer = (worker: JsonObject | undefined): boolean => Boolean(
    worker
    && worker.classification === "reviewer"
    && worker.is_judge !== true
    && worker.instantiated === true
    && worker.status === "completed"
    && worker.blind_round1 === true
    && worker.context_isolated === true
    && participated(worker).includes("round1")
    && !participated(worker).includes("final_judge")
    && !participated(worker).includes("adaptive_specialist"),
  );
  const eligibleJudge = (worker: JsonObject | undefined): boolean => Boolean(
    worker
    && worker.classification === "judge"
    && worker.is_judge === true
    && worker.instantiated === true
    && worker.status === "completed"
    && worker.blind_round1 === false
    && worker.context_isolated === true
    && isDeepStrictEqual(participated(worker), ["final_judge"]),
  );

  const failures = array(run.failures).map(object);
  const failureIds = failures.map((failure) => failure.worker_id).filter((id): id is string => typeof id === "string");
  const declaredFailed = new Set([...workerById].filter(([, worker]) => worker.status === "failed").map(([id]) => id));
  if (
    !duplicateFree(failureIds)
    || !sameValues(new Set(failureIds), declaredFailed)
    || failures.some((failure) => !nonempty(failure.reason))
  ) {
    errors.push("run.failures must exactly identify failed workers with reasons");
  }

  const completedIds = stringArray(run.completed_worker_ids);
  const reusedIds = stringArray(run.reused_worker_ids);
  const completed = new Set(completedIds);
  const reused = new Set(reusedIds);
  if (!duplicateFree(completedIds) || !duplicateFree(reusedIds) || [...completed].some((id) => reused.has(id))) {
    errors.push("completed and reused worker identities must be unique and distinct");
  }
  for (const [id, worker] of workerById) {
    if (worker.status === "completed" && !completed.has(id)) errors.push("completed worker missing from completed ids");
    if (worker.status === "reused" && !reused.has(id)) errors.push("reused worker missing from reused ids");
    if (["completed", "reused", "failed"].includes(String(worker.status)) && worker.instantiated !== true) {
      errors.push("lifecycle workers must be instantiated");
    }
  }
  for (const id of [...completed, ...reused]) {
    const worker = workerById.get(id);
    if (!worker || (completed.has(id) && worker.status !== "completed") || (reused.has(id) && worker.status !== "reused")) {
      errors.push("completed/reused ids must match worker lifecycle status");
    }
  }

  const judgeId = run.fresh_judge_id;
  const fallback = run.judge_fallback;
  const reviewerIds = new Set([...workerById].filter(([, worker]) => eligibleReviewer(worker)).map(([id]) => id));
  if ((stage === "HIGH" || stage === "CRITICAL") && !strictShortfall) {
    if (fallback === null && (!nonempty(judgeId) || !completed.has(judgeId) || !eligibleJudge(workerById.get(judgeId)))) {
      errors.push("HIGH/CRITICAL requires a completed fresh Judge");
    }
    if (typeof judgeId === "string" && (reviewerIds.has(judgeId) || reused.has(judgeId))) {
      errors.push("Judge must be fresh and not reused");
    }
    if (stage === "HIGH" && assurance === "independent" && run.capability_shortfall !== true && reviewerIds.size < 4) {
      errors.push("HIGH requires at least four eligible completed reviewers");
    }
    if (stage === "CRITICAL" && assurance === "independent" && run.capability_shortfall !== true) {
      if (reviewerIds.size < 5 || reviewerIds.size > 6) errors.push("CRITICAL requires five or six reviewers");
      const roles = [...reviewerIds].map((id) => String(workerById.get(id)?.role ?? "").toLowerCase()).join(" ");
      if (!roles.includes("red team") && !roles.includes("independent design-assurance")) {
        errors.push("CRITICAL requires a red-team or independent design-assurance reviewer");
      }
    }
    if (assurance === "partially_independent" && reviewerIds.size === 0) {
      errors.push("partially_independent HIGH/CRITICAL requires an eligible reviewer");
    }
  } else if (stage === "LOW" && judgeId !== null) {
    errors.push("LOW must not claim a fresh Judge");
  } else if (stage === "MEDIUM" && judgeId !== null && (
    !nonempty(judgeId) || !completed.has(judgeId) || reused.has(judgeId) || !eligibleJudge(workerById.get(judgeId))
  )) {
    errors.push("MEDIUM fresh Judge must be completed, isolated, and unreused");
  }

  if (fallback !== null) {
    const fallbackObject = object(fallback);
    if (fallbackObject.provisional !== true || !nonempty(fallbackObject.reason) || judgeId !== null) {
      errors.push("Judge fallback must be provisional, explained, and exclusive of a fresh Judge");
    }
    if ((stage === "HIGH" || stage === "CRITICAL") && assurance !== "provisional") {
      errors.push("HIGH/CRITICAL Judge fallback must use provisional assurance");
    }
    if (run.strict === true) errors.push("strict execution cannot use a Judge fallback");
  }

  if (strictShortfall) {
    const cross = object(record.cross_examination);
    const emptyRunFields = ["workers", "completed_worker_ids", "reused_worker_ids", "failures", "specialist_additions", "redeliberations"];
    const emptyRootFields = ["panel_manifest", "material_claims", "issue_ledger", "axis_decisions"];
    if (
      assurance !== "provisional"
      || record.consensus_proposal !== null
      || judgeId !== null
      || fallback !== null
      || instantiated.size > 0
      || missingSet.size === 0
      || emptyRunFields.some((field) => array(run[field]).length > 0)
      || emptyRootFields.some((field) => array(record[field]).length > 0)
      || cross.decision !== "skip"
      || !nonempty(cross.reason)
      || ["trigger_items", "selected_item_ids", "coverage", "followups"].some((field) => array(cross[field]).length > 0)
    ) {
      errors.push("strict capability shortfall contract is inconsistent");
    }
    return errors;
  }

  if (stage === "LOW" && workerById.size > 0) errors.push("LOW must not create panel workers");
  if (stage === "MEDIUM") {
    if (reviewerIds.size < 2 || reviewerIds.size > 3) errors.push("MEDIUM requires two or three reviewers");
    if (assurance === "independent" && judgeId === null) errors.push("MEDIUM independent assurance requires a fresh Judge");
  }

  const specialists = array(run.specialist_additions).map(object);
  if (specialists.length > 1) errors.push("at most one specialist addition is allowed");
  const specialistIds: string[] = [];
  for (const specialist of specialists) {
    const workerId = specialist.worker_id;
    if (typeof workerId === "string") specialistIds.push(workerId);
    const worker = typeof workerId === "string" ? workerById.get(workerId) : undefined;
    const admission = object(specialist.admission);
    if (
      !nonempty(specialist.admission_reason)
      || !nonempty(specialist.reason)
      || specialist.classification !== "adaptive_specialist"
      || worker?.classification !== "adaptive_specialist"
      || worker.status !== "completed"
      || worker.instantiated !== true
      || worker.is_judge === true
      || worker.blind_round1 !== false
      || worker.context_isolated !== true
      || !participated(worker).includes("adaptive_specialist")
      || admission.material_gap !== true
      || admission.distinct_capability !== true
      || admission.verdict_change_possible !== true
      || admission.cap_available !== true
    ) {
      errors.push("specialist admission contract is invalid");
    }
  }
  const declaredSpecialists = new Set([...workerById]
    .filter(([, worker]) => worker.classification === "adaptive_specialist" && worker.instantiated === true && worker.status === "completed")
    .map(([id]) => id));
  if (!duplicateFree(specialistIds) || !sameValues(new Set(specialistIds), declaredSpecialists)) {
    errors.push("specialist additions must identify every completed specialist");
  }

  const redeliberations = array(run.redeliberations).map(object);
  if (redeliberations.length > 1) errors.push("at most one re-deliberation is allowed");
  for (const redeliberation of redeliberations) {
    const scope = stringArray(redeliberation.impacted_scope);
    const participants = stringArray(redeliberation.participant_worker_ids);
    if (!scope.length || !participants.length || !duplicateFree(scope) || !duplicateFree(participants) || redeliberation.non_independent !== true) {
      errors.push("re-deliberation requires unique scope, participants, and non_independent=true");
    }
    for (const id of participants) {
      const worker = workerById.get(id);
      if (!worker || worker.instantiated !== true || worker.status !== "completed" || !["reviewer", "adaptive_specialist"].includes(String(worker.classification))) {
        errors.push("re-deliberation participants must be completed existing reviewers or specialists");
      }
    }
  }

  const claimStatuses = new Map<string, Set<string>>();
  for (const claim of array(record.material_claims).map(object)) {
    if (!nonempty(claim.id) || claimStatuses.has(claim.id)) {
      errors.push("material claim ids must be unique nonempty strings");
      continue;
    }
    const provenance = array(claim.provenance).map(object);
    if (!provenance.length) errors.push("material claims require provenance");
    const statuses = new Set<string>();
    for (const source of provenance) {
      if (!EVIDENCE_STATUSES.has(String(source.verification_status))) {
        errors.push("material claim has invalid verification status");
      } else {
        statuses.add(String(source.verification_status));
      }
      if (source.verification_status === "verified" && (!nonempty(source.locator) || !nonempty(source.verification_note))) {
        errors.push("verified provenance requires a locator and verification note");
      }
    }
    claimStatuses.set(claim.id, statuses);
  }

  const scanForbidden = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(scanForbidden);
    } else if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as JsonObject)) {
        if (FORBIDDEN_KEYS.has(key.toLowerCase())) errors.push("DecisionRecord must not retain raw reasoning, prompts, or directives");
        scanForbidden(child);
      }
    }
  };
  scanForbidden(record);

  const constraints = new Set(stringArray(record.constraints));
  const requiredConstraints = new Set(stringArray(record.required_constraints));
  if ([...requiredConstraints].some((constraint) => !constraints.has(constraint))) {
    errors.push("required constraints must be declared constraints");
  }
  const issues = array(record.issue_ledger).map(object);
  for (const issue of issues) {
    if (!ISSUE_STATUSES.has(String(issue.status))) errors.push("issue ledger has invalid status");
  }
  const observability = object(record.observability);
  for (const value of Object.values(observability)) {
    if (typeof value === "string" && value !== "NOT_OBSERVABLE") errors.push("observability strings must be NOT_OBSERVABLE");
  }
  if (typeof observability.worker_count === "number" && observability.worker_count !== instantiated.size) {
    errors.push("observability worker_count must match instantiated workers");
  }

  const cross = object(record.cross_examination);
  const triggers = array(cross.trigger_items).map(object);
  const selected = stringArray(cross.selected_item_ids);
  const coverage = array(cross.coverage).map(object);
  const followups = array(cross.followups).map(object);
  if (!nonempty(cross.reason)) errors.push("cross-examination requires a reason");
  const triggerOrigins = new Map<string, string>();
  for (const trigger of triggers) {
    if (!nonempty(trigger.id) || triggerOrigins.has(trigger.id) || !nonempty(trigger.origin_reviewer) || !eligibleReviewer(workerById.get(trigger.origin_reviewer))) {
      errors.push("cross trigger ids and origins are invalid");
    } else {
      triggerOrigins.set(trigger.id, trigger.origin_reviewer);
    }
  }
  if (cross.decision === "skip" && (triggers.length || selected.length || coverage.length || followups.length)) {
    errors.push("cross-examination skip requires empty details");
  }
  if (cross.decision === "run") {
    if (!triggers.length || !coverage.length || !followups.length || !duplicateFree(selected) || !sameValues(new Set(selected), new Set(triggerOrigins.keys()))) {
      errors.push("cross-examination run must select every trigger exactly once");
    }
    const coverageIds = coverage.map((entry) => String(entry.item_id));
    if (!duplicateFree(coverageIds) || !sameValues(new Set(coverageIds), new Set(selected))) {
      errors.push("cross coverage must identify every selected item");
    }
    for (const entry of coverage) {
      const itemId = String(entry.item_id);
      const reviewerIdsForItem = stringArray(entry.reviewer_ids);
      if (!duplicateFree(reviewerIdsForItem) || !reviewerIdsForItem.some((id) => id !== triggerOrigins.get(itemId)) || reviewerIdsForItem.some((id) => !eligibleReviewer(workerById.get(id)))) {
        errors.push("cross coverage requires eligible non-origin reviewers");
      }
      if (!followups.some((followup) => reviewerIdsForItem.includes(String(followup.reviewer_id)) && stringArray(followup.item_ids).includes(itemId))) {
        errors.push("cross coverage must have a matching follow-up");
      }
    }
  }
  const followupCounts = new Map<string, number>();
  for (const followup of followups) {
    const reviewerId = String(followup.reviewer_id);
    followupCounts.set(reviewerId, (followupCounts.get(reviewerId) ?? 0) + 1);
    const itemIds = stringArray(followup.item_ids);
    if (!eligibleReviewer(workerById.get(reviewerId)) || !duplicateFree(itemIds) || itemIds.some((id) => !selected.includes(id))) {
      errors.push("cross follow-up must use eligible reviewers and selected items");
    }
  }
  if ([...followupCounts.values()].some((count) => count > 1)) errors.push("reviewers may receive at most one cross follow-up");

  const axes = array(record.axis_decisions).map(object);
  const axisNames = new Set<string>();
  for (const axis of axes) {
    if (!nonempty(axis.axis) || axisNames.has(axis.axis)) {
      errors.push("axis decisions must have unique nonempty names");
    } else {
      axisNames.add(axis.axis);
    }
    for (const claimId of stringArray(axis.evidence_claim_ids)) {
      const statuses = claimStatuses.get(claimId);
      if (!statuses || !sameValues(statuses, new Set(["verified"]))) errors.push("axis evidence must reference verified claims");
    }
  }
  const validScope = new Set([...claimStatuses.keys(), ...issues.map((issue) => String(issue.issue_id)), ...axisNames]);
  for (const redeliberation of redeliberations) {
    if (stringArray(redeliberation.impacted_scope).some((id) => !validScope.has(id))) {
      errors.push("re-deliberation scope must reference existing claims, issues, or axes");
    }
  }
  if ((declaredSpecialists.size || redeliberations.length) && assurance === "independent") {
    errors.push("material adaptive work cannot claim independent assurance");
  }
  if (assurance === "independent" && (missingSet.size || failures.length || reused.size)) {
    errors.push("independent assurance requires no missing capability, failures, or reuse");
  }

  const proposal = object(record.consensus_proposal);
  const status = proposal.status;
  const supported = stringArray(proposal.supported_by_verified_claims);
  if ((status === "consensus" || status === "conditional_consensus") && (!supported.length || !axes.length)) {
    errors.push("consensus requires verified support and decision axes");
  }
  for (const claimId of supported) {
    const statuses = claimStatuses.get(claimId);
    if (!statuses || !sameValues(statuses, new Set(["verified"]))) errors.push("consensus links must reference verified claims only");
  }
  const satisfied = stringArray(proposal.satisfied_constraints);
  if (satisfied.some((constraint) => !constraints.has(constraint))) errors.push("consensus references undeclared constraints");
  const alignment = array(proposal.axis_alignment).map(object);
  const alignedAxes = alignment.map((entry) => String(entry.axis));
  if (status !== "no_consensus" && (!duplicateFree(alignedAxes) || !sameValues(new Set(alignedAxes), axisNames))) {
    errors.push("consensus must link every decision axis exactly once");
  }
  if (status !== "no_consensus" && alignment.some((entry) => entry.decision_ref !== entry.axis)) {
    errors.push("consensus decision_ref must match its axis");
  }
  const materialDissent = array(proposal.unresolved_dissent).map(object).some((item) => item.material === true);
  if (status === "consensus") {
    if (!nonempty(proposal.action) || array(proposal.conditions).length || materialDissent) errors.push("unconditional consensus shape is invalid");
    if (issues.some((issue) => issue.status === "UNRESOLVED" || issue.status === "NOT_OBSERVABLE")) errors.push("unresolved issues prevent consensus");
    if (!sameValues(new Set(satisfied), requiredConstraints)) errors.push("consensus must satisfy every required constraint");
  } else if (status === "conditional_consensus") {
    if (!nonempty(proposal.action) || !array(proposal.conditions).length || !sameValues(new Set(satisfied), requiredConstraints)) {
      errors.push("conditional consensus shape is invalid");
    }
  } else if (status === "no_consensus") {
    if (proposal.action !== null || !nonempty(proposal.no_consensus_reason) || !array(proposal.remaining_options).length || !nonempty(proposal.decision_owner)) {
      errors.push("no_consensus shape is invalid");
    }
  }
  if (status !== "no_consensus" && (proposal.no_consensus_reason !== null || proposal.decision_owner !== null)) {
    errors.push("only no_consensus may include a no-consensus reason or owner");
  }
  return errors;
}
