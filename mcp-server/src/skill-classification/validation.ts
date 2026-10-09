import { z } from "zod";
import { digestClassificationValue } from "./request.js";
import type { ClassificationResult, ClassificationSnapshot, SkillClassificationRequestV1, SkillClassificationResponseV1, SkillSelectionDecisionV1 } from "./types.js";

const text = z.string().min(1);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const ids = z.array(text);
const version = z.literal("1.0.0");
export const responseSchema = z.strictObject({
  schemaVersion: version, requestId: text, operationId: text, requestDigest: digest, inventoryDigest: digest,
  status: z.enum(["SUCCESS", "PARTIAL", "UNAVAILABLE", "INVALID", "UNCERTAIN"]),
  judgments: z.array(z.strictObject({skillId: text, judgment: z.enum(["needed", "not-needed", "uncertain"]), reasonRefs: ids, uncertaintyReason: text.nullable()})),
  unresolvedItems: z.array(z.strictObject({skillId: text.nullable(), reasonCode: text})),
  error: z.strictObject({code: text, retryable: z.boolean(), dispatchState: z.enum(["not-started", "started", "unknown"])}).nullable(),
});
export const decisionSchema = z.strictObject({
  schemaVersion: version, classificationResponseRef: digest, requestDigest: digest, inventoryDigest: digest,
  taskRevision: text.nullable(), configRevision: text, profileRevision: text,
  explicitSkillIds: ids, ruleRequiredSkillIds: ids, agentSelectedSkillIds: ids.nullable(),
  selectionReasons: z.array(z.strictObject({skillId: text, reason: text})),
  applicabilityChecks: z.array(z.strictObject({skillId: text, applies: z.boolean().nullable(), excluded: z.boolean().nullable(), reasonRefs: ids})),
  unresolvedSkillReferences: z.array(z.strictObject({reference: text, reason: text})),
  selectionStatus: z.enum(["PROPOSED", "SELECTED", "PARTIAL", "NEEDS_INPUT"]), adviceApplied: z.boolean(),
  hostReceipt: z.strictObject({receiptId: text, host: text, requestDigest: digest, inventoryDigest: digest, agentSelectedSkillIds: ids, acceptedAt: z.iso.datetime()}).nullable(),
});

/** The schema accepts unknown input; no missing candidate is silently a negative judgment. */
export function validateClassificationResponse(request: SkillClassificationRequestV1, response: SkillClassificationResponseV1): string[] {
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success) return ["INVALID_RESPONSE_SCHEMA"];
  const errors: string[] = [];
  for (const field of ["requestId", "operationId", "requestDigest", "inventoryDigest"] as const) {
    if (response[field] !== request[field]) errors.push(`RESPONSE_BINDING_${field}`);
  }
  const inventory = new Set(request.skills.map(skill => skill.skillId));
  const seen = new Set<string>();
  for (const item of response.judgments) {
    if (!inventory.has(item.skillId)) errors.push("UNKNOWN_SKILL_ID");
    if (seen.has(item.skillId)) errors.push("DUPLICATE_SKILL_ID");
    seen.add(item.skillId);
    if (item.judgment === "uncertain" && !item.uncertaintyReason?.trim()) errors.push("MISSING_UNCERTAINTY_REASON");
    if (item.judgment !== "uncertain" && item.reasonRefs.length === 0) errors.push("MISSING_JUDGMENT_REASON");
  }
  const unresolved = new Set(response.unresolvedItems.flatMap(item => item.skillId === null ? [] : [item.skillId]));
  if (response.unresolvedItems.some(item => item.skillId !== null && !inventory.has(item.skillId))) errors.push("UNKNOWN_UNRESOLVED_SKILL");
  const semanticUncertainty = response.status === "UNCERTAIN" && response.error === null;
  if (["SUCCESS", "PARTIAL"].includes(response.status) || semanticUncertainty) {
    if ([...inventory].some(id => !seen.has(id))) errors.push("MISSING_CANDIDATE_JUDGMENT");
    if (response.error !== null) errors.push("SUCCESS_WITH_ERROR");
  }
  if (semanticUncertainty && response.unresolvedItems.length === 0 && !response.judgments.some(item => item.judgment === "uncertain")) errors.push("MISSING_UNCERTAINTY_EVIDENCE");
  if (response.status === "SUCCESS" && (unresolved.size > 0 || response.unresolvedItems.length > 0 || response.judgments.some(item => item.judgment === "uncertain"))) errors.push("SUCCESS_WITH_UNRESOLVED_ITEMS");
  if (["UNAVAILABLE", "INVALID"].includes(response.status) && response.error === null) errors.push("FAILURE_WITHOUT_ERROR");
  return [...new Set(errors)];
}

export interface SelectionValidation {
  valid: boolean;
  errors: string[];
  neededSkillIds: string[];
  runnableSkillIds: string[];
  blockedItems: {skillId: string; reasonCode: string}[];
}

/** Reports omissions; never creates or replaces the AGENT's final selection set. */
export function validateDecision(result: ClassificationResult, decision: SkillSelectionDecisionV1, current: ClassificationSnapshot): SelectionValidation {
  const errors: string[] = [];
  const blockedItems: SelectionValidation["blockedItems"] = [];
  const needed = new Set(result.response.judgments.filter(item => item.judgment === "needed").map(item => item.skillId));
  const parsed = decisionSchema.safeParse(decision);
  if (!parsed.success) return {valid: false, errors: ["INVALID_DECISION_SCHEMA"], neededSkillIds: [...needed], runnableSkillIds: [], blockedItems};
  if (decision.classificationResponseRef !== digestClassificationValue(result.response)) errors.push("CLASSIFICATION_RESPONSE_REF_MISMATCH");
  if ((result.response.error !== null || ["UNAVAILABLE", "INVALID"].includes(result.response.status)) && decision.selectionStatus === "SELECTED") errors.push("CLASSIFICATION_UNAVAILABLE_CANNOT_COMPLETE_SELECTION");
  for (const id of [...decision.explicitSkillIds, ...decision.ruleRequiredSkillIds]) needed.add(id);
  for (const field of ["taskRevision", "configRevision", "profileRevision", "inventoryDigest", "requestDigest"] as const) {
    if (result.snapshot[field] !== current[field] || decision[field] !== current[field]) errors.push(`STALE_${field}`);
  }
  if (current.cancelled) errors.push("TASK_CANCELLED");
  const inventory = new Map(result.request.skills.map(skill => [skill.skillId, skill]));
  // Availability applies to required advice even when the AGENT does not select it.
  const selected = decision.agentSelectedSkillIds;
  for (const id of new Set([...needed, ...(selected ?? [])])) {
    const skill = inventory.get(id);
    if (skill && (!skill.enabled || !skill.installed || !skill.hostSupported)) blockedItems.push({skillId: id, reasonCode: !skill.enabled ? "DISABLED" : !skill.installed ? "NOT_INSTALLED" : "HOST_UNSUPPORTED"});
  }
  if (selected === null) {
    if (["SELECTED", "PARTIAL"].includes(decision.selectionStatus) || decision.hostReceipt !== null || decision.adviceApplied) errors.push("SELECTION_NOT_OBSERVED");
  } else {
    if (!["SELECTED", "PARTIAL"].includes(decision.selectionStatus)) errors.push("SELECTED_STATUS_MISMATCH");
    if (new Set(selected).size !== selected.length) errors.push("DUPLICATE_SELECTED_SKILL");
    const receipt = decision.hostReceipt;
    if (!receipt || receipt.requestDigest !== current.requestDigest || receipt.inventoryDigest !== current.inventoryDigest
      || JSON.stringify([...receipt.agentSelectedSkillIds].sort()) !== JSON.stringify([...selected].sort())) errors.push("HOST_RECEIPT_MISMATCH");
    for (const id of [...decision.explicitSkillIds, ...decision.ruleRequiredSkillIds]) {
      if (!selected.includes(id)) errors.push(`REQUIRED_SKILL_OMITTED:${id}`);
    }
    for (const id of selected) {
      const skill = inventory.get(id);
      if (!skill) { errors.push(`UNKNOWN_SELECTED_SKILL:${id}`); continue; }
      const checks = decision.applicabilityChecks.filter(check => check.skillId === id);
      if (checks.length !== 1 || checks[0]?.applies !== true || checks[0]?.excluded !== false || checks[0]?.reasonRefs.length === 0) errors.push(`APPLICABILITY_UNRESOLVED:${id}`);
      if (!decision.selectionReasons.some(reason => reason.skillId === id)) errors.push(`SELECTION_REASON_MISSING:${id}`);
      for (const dependency of skill.dependencies) if (!selected.includes(dependency)) errors.push(`DEPENDENCY_OMITTED:${id}:${dependency}`);
    }
    if (decision.selectionStatus === "SELECTED" && (blockedItems.length > 0 || decision.unresolvedSkillReferences.length > 0)) errors.push("UNRESOLVED_SELECTION_MARKED_COMPLETE");
  }
  if (result.config.mode === "shadow" && decision.adviceApplied) errors.push("SHADOW_ADVICE_APPLIED");
  const unresolved = [...needed].filter(id => !inventory.has(id));
  for (const id of unresolved) blockedItems.push({skillId: id, reasonCode: "UNKNOWN_REQUIRED_SKILL"});
  return {valid: errors.length === 0, errors: [...new Set(errors)], neededSkillIds: [...needed].sort(), runnableSkillIds: (selected ?? []).filter(id => !blockedItems.some(item => item.skillId === id)).sort(), blockedItems};
}
