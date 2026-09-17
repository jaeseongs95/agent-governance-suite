import { checkResult } from "./result-checker.mjs";
import { overlapsProtectedSpan } from "./protected-spans.mjs";
import { createSourceUnitManifest } from "./source-units.mjs";
import { ContractError, SCHEMA_VERSION, requireObject, sha256, stableJson } from "./lib.mjs";
import { validateProviderPlan } from "./provider-plan.mjs";

/** @typedef {{id: string, unitId: string, sourceDigest: string, start: number, end: number, replacement: string, actorId: string}} Edit */
/** @typedef {{editId: string, decision: "accept" | "retain", reasonCode: string, sourceDefect: string, invariantDelta: string}} VerificationDecision */
/** @typedef {{unitId: string, start: number, end: number, kind: "prose" | "fenced-code"}} SourceUnit */

const DIGEST = /^[a-f0-9]{64}$/u;
const CODE = /^[A-Z][A-Z0-9_]*$/u;
const ISSUE_CODES = new Set(["AMBIGUOUS_RELATIONSHIP", "GRAMMATICAL_MISMATCH", "NOUN_STACKING", "REDUNDANCY", "TRANSLATIONESE", "UNNECESSARY_META_PROSE", "UNSUPPORTED_EMPHASIS", "USER_FACING_IMPLEMENTATION_JARGON"]);
const PROTECTED_KINDS = new Set(["fenced-code", "inline-code", "command", "markdown-target", "url", "email", "path", "quotation", "number-or-date", "user-defined", "glossary"]);
const GLOSSARY_STATUSES = new Set(["matched", "no-match", "unavailable", "limit-exceeded", "unsupported-normalization"]);
const GLOSSARY_POLICIES = new Set(["protect", "prefer", "allow", "avoid"]);

/**
 * @param {unknown} value
 * @returns {{output: string, receipt: Record<string, unknown>}}
 */
export function finalizeRequest(value) {
  const request = requireObject(value, "request");
  if (request.schemaVersion !== SCHEMA_VERSION) throw new ContractError("REQUEST_SCHEMA_VERSION", "unsupported request schema version");
  if (request.mode !== "mcp" && request.mode !== "direct") throw new ContractError("MODE", "mode must be mcp or direct");
  const mode = request.mode;
  if (typeof request.source !== "string") throw new ContractError("SOURCE", "source must be a string");
  const source = request.source;
  const sourceDigest = sha256(source);
  const plan = validateProviderPlan(request.plan, { subagentsAvailable: request.subagentsAvailable === true });
  const actorIds = plan.actorIds;
  const manifest = requireObject(request.manifest, "manifest");
  const sourceUnitManifest = requireObject(request.sourceUnitManifest, "sourceUnitManifest");
  const selection = requireObject(request.selection, "selection");
  const editing = requireObject(request.editing, "editing");
  const verification = requireObject(request.verification, "verification");
  const warnings = new Set();
  let fallback = false;

  if (!validProtectedManifest(manifest, source)) {
    warnings.add("SOURCE_MANIFEST_MISMATCH");
    fallback = true;
  }

  const glossaryContext = validateGlossaryContext(mode, sourceDigest, request.glossaryMatchSet, manifest);
  for (const warning of glossaryContext.warnings) warnings.add(warning);
  if (!glossaryContext.valid) {
    warnings.add("GLOSSARY_MATCH_SET_INVALID");
    fallback = true;
  }
  const expectedGlossaryBinding = glossaryContext.binding;
  if (stableJson(selection.glossaryBinding) !== stableJson(expectedGlossaryBinding)
    || stableJson(editing.glossaryBinding) !== stableJson(expectedGlossaryBinding)
    || stableJson(verification.glossaryBinding) !== stableJson(expectedGlossaryBinding)) {
    warnings.add("GLOSSARY_BINDING_MISMATCH");
    fallback = true;
  }

  /** @type {SourceUnit[]} */
  let units = [];
  if (!fallback) {
    const expectedUnits = createSourceUnitManifest(source, /** @type {any} */ (manifest));
    if (stableJson(sourceUnitManifest) !== stableJson(expectedUnits)) {
      warnings.add("SOURCE_UNIT_MANIFEST_MISMATCH");
      fallback = true;
    } else {
      units = /** @type {SourceUnit[]} */ (expectedUnits.units);
    }
  }

  const unitById = new Map(units.map((unit) => [unit.unitId, unit]));
  const selectionByUnit = new Map();
  if (!validSelection(selection, sourceDigest, actorIds[0], unitById, source, expectedGlossaryBinding)) {
    warnings.add("SELECTION_CONTRACT_INVALID");
    fallback = true;
  } else {
    for (const decision of /** @type {any[]} */ (selection.decisions)) selectionByUnit.set(decision.unitId, decision);
    if (selection.status !== "ready") {
      warnings.add("SELECTION_NOT_READY");
      fallback = true;
    }
  }

  const selectionDigest = sha256(stableJson(selection));
  /** @type {Edit[]} */
  const edits = [];
  if (!validEditingRoot(editing, sourceDigest, selectionDigest, actorIds[1], expectedGlossaryBinding)) {
    if (editing.selectionDigest === selectionDigest) warnings.add("EDIT_CONTRACT_INVALID");
    else warnings.add("SELECTION_DIGEST_MISMATCH");
    fallback = true;
  }

  const rawEdits = Array.isArray(editing.edits) ? editing.edits : [];
  const editIds = new Set();
  for (const rawEdit of rawEdits) {
    if (!validEdit(rawEdit, source, sourceDigest, actorIds[1], editIds)) {
      warnings.add("EDIT_CONTRACT_INVALID");
      fallback = true;
      continue;
    }
    const edit = /** @type {Edit} */ (rawEdit);
    editIds.add(edit.id);
    edits.push(edit);
  }
  edits.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].start < edits[index - 1].end || (edits[index].start === edits[index - 1].start && edits[index].start === edits[index].end)) {
      warnings.add("EDIT_RANGES_OVERLAP");
      fallback = true;
    }
  }

  if (!fallback && editing.candidateDigest !== sha256(applyEdits(source, edits))) {
    warnings.add("EDITING_DIGEST_MISMATCH");
    fallback = true;
  }

  const editingDigest = sha256(stableJson(editing));
  if (!validVerificationRoot(verification, sourceDigest, editingDigest, actorIds[2], expectedGlossaryBinding)) {
    if (verification.editingDigest === editingDigest) warnings.add("VERIFICATION_CONTRACT_INVALID");
    else warnings.add("VERIFICATION_DIGEST_MISMATCH");
    fallback = true;
  }
  if (typeof request.rubricDigest !== "string" || !DIGEST.test(request.rubricDigest) || verification.rubricDigest !== request.rubricDigest) {
    warnings.add("VERIFICATION_RUBRIC_DIGEST_MISMATCH");
    fallback = true;
  }
  if (verification.globalDecision === "fallback") {
    warnings.add("VERIFIER_GLOBAL_FALLBACK");
    fallback = true;
  }

  /** @type {Map<string, VerificationDecision>} */
  const decisionByEdit = new Map();
  const rawDecisions = Array.isArray(verification.decisions) ? verification.decisions : [];
  for (const rawDecision of rawDecisions) {
    if (!validVerificationDecision(rawDecision) || decisionByEdit.has(rawDecision.editId) || !editIds.has(rawDecision.editId)) {
      warnings.add("VERIFICATION_DECISION_INVALID");
      fallback = true;
      continue;
    }
    decisionByEdit.set(rawDecision.editId, /** @type {VerificationDecision} */ (rawDecision));
  }

  const effectiveManifest = fallback
    ? manifest
    : addSelectionProtectedStrings(source, /** @type {any} */ (manifest), /** @type {any[]} */ (selection.decisions), unitById);
  const spans = Array.isArray(effectiveManifest.spans) ? effectiveManifest.spans : [];
  /** @type {Edit[]} */
  const accepted = [];
  /** @type {Edit[]} */
  const retained = [];
  for (const edit of edits) {
    const unit = unitById.get(edit.unitId);
    const selected = selectionByUnit.get(edit.unitId);
    if (!unit || !selected || selected.action !== "edit" || edit.start < unit.start || edit.end > unit.end || !selected.issueRanges.some((issue) => rangesOverlap(edit, issue))) {
      retained.push(edit);
      warnings.add("EDIT_OUT_OF_SCOPE_RETAINED");
      continue;
    }
    if (unit.kind === "fenced-code" || overlapsProtectedSpan(edit.start, edit.end, spans)) {
      retained.push(edit);
      warnings.add("PROTECTED_EDIT_RETAINED");
      continue;
    }
    if (!isMinimalEdit(source, edit)) {
      retained.push(edit);
      warnings.add("NON_MINIMAL_EDIT_RETAINED");
      continue;
    }
    const decision = decisionByEdit.get(edit.id);
    if (decision?.decision !== "accept") {
      retained.push(edit);
      if (!decision) warnings.add("VERIFICATION_DECISION_MISSING");
      continue;
    }
    accepted.push(edit);
  }

  if (!fallback && accepted.length > 0 && !acceptedAssessmentIsSafe(verification.assessment)) {
    warnings.add("VERIFICATION_CONTRACT_INVALID");
    fallback = true;
  }

  let output = source;
  if (!fallback) {
    output = applyEdits(source, accepted);
    const check = checkResult(source, output, effectiveManifest);
    if (check.decisions.protectedSpansPreserved !== true) {
      warnings.add("FINAL_PROTECTED_CHECK_FAILED");
      for (const warning of check.warnings) warnings.add(warning);
      fallback = true;
      output = source;
    }
  }

  const applied = fallback ? [] : accepted;
  const allRetained = fallback ? edits : retained;
  if (fallback) warnings.add("GLOBAL_FALLBACK_APPLIED");
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    actorIds,
    digest: {
      source: sourceDigest,
      result: sha256(output),
      manifest: sha256(stableJson(effectiveManifest)),
    },
    length: { source: source.length, result: output.length },
    glossary: glossaryContext.summary,
    decisions: {
      mode,
      assurance: mode === "mcp" && !fallback ? "verified" : "unverified",
      status: fallback ? "fallback" : "finalized",
      appliedEditDigests: applied.map((edit) => sha256(edit.id)),
      retainedEditDigests: allRetained.map((edit) => sha256(edit.id)),
      fallback,
    },
    warnings: [...warnings].sort(),
  };

  return { output, receipt };
}

/** @param {{output: string, receipt: Record<string, unknown>}} result @param {"mcp" | "direct"} mode */
export function formatFinalizationResponse(result, mode) {
  if (mode === "mcp") return result.receipt;
  return { output: result.output, verificationStatus: "unverified", receipt: result.receipt };
}

/** @param {"mcp" | "direct"} mode @param {string} sourceDigest @param {unknown} value @param {Record<string, unknown>} manifest */
function validateGlossaryContext(mode, sourceDigest, value, manifest) {
  const directBinding = { schemaVersion: SCHEMA_VERSION, mode: "none" };
  const directSummary = { mode: "none", status: "direct", id: null, version: null, contentDigest: null, matchSetDigest: null, matchCount: 0, warnings: [] };
  if (mode === "direct") return { valid: value === null, binding: directBinding, summary: directSummary, warnings: [] };

  const invalidSummary = { mode: "mcp", status: "unavailable", id: null, version: null, contentDigest: null, matchSetDigest: null, matchCount: 0, warnings: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
  const matchSet = /** @type {Record<string, unknown>} */ (value);
  if (!hasExactKeys(matchSet, ["schemaVersion", "status", "sourceDigest", "glossary", "matches", "matchSetDigest", "warnings"])
    || matchSet.schemaVersion !== SCHEMA_VERSION || matchSet.sourceDigest !== sourceDigest
    || typeof matchSet.status !== "string" || !GLOSSARY_STATUSES.has(matchSet.status)
    || !Array.isArray(matchSet.matches) || matchSet.matches.length > 256 || !Array.isArray(matchSet.warnings)) {
    return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
  }
  const status = /** @type {string} */ (matchSet.status);
  const warningSets = {
    matched: [],
    "no-match": [],
    unavailable: ["GLOSSARY_UNAVAILABLE"],
    "limit-exceeded": ["GLOSSARY_MATCH_LIMIT_EXCEEDED"],
    "unsupported-normalization": ["GLOSSARY_UNSUPPORTED_NORMALIZATION"],
  };
  const expectedWarnings = warningSets[status];
  if (stableJson(matchSet.warnings) !== stableJson(expectedWarnings)) return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };

  const available = status === "matched" || status === "no-match";
  const glossary = matchSet.glossary;
  const validGlossaryMetadata = glossary && typeof glossary === "object" && !Array.isArray(glossary)
    && hasExactKeys(glossary, ["id", "version", "contentDigest"])
    && glossary.id === "korean-prose-core" && glossary.version === "1.2.1"
    && typeof glossary.contentDigest === "string" && DIGEST.test(glossary.contentDigest);
  if (available) {
    if (!validGlossaryMetadata
      || typeof matchSet.matchSetDigest !== "string" || !DIGEST.test(matchSet.matchSetDigest)) {
      return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
    }
  } else if (matchSet.matchSetDigest !== null || (glossary !== null && (status !== "limit-exceeded" || !validGlossaryMetadata))) {
    return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
  }

  const matches = /** @type {Record<string, unknown>[]} */ (matchSet.matches);
  if ((!available && matches.length !== 0) || (status === "matched" && matches.length === 0) || (status === "no-match" && matches.length !== 0)) {
    return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
  }
  for (const match of matches) {
    if (!match || typeof match !== "object" || Array.isArray(match)
      || !hasExactKeys(match, ["start", "end", "entryId", "policy", "canonicalForm", "priority"])
      || !Number.isInteger(match.start) || !Number.isInteger(match.end)
      || /** @type {number} */ (match.start) < 0 || /** @type {number} */ (match.end) <= /** @type {number} */ (match.start)
      || /** @type {number} */ (match.end) > /** @type {number} */ (manifest.sourceLength ?? 0)
      || typeof match.entryId !== "string" || !/^[a-z0-9][a-z0-9-]*$/u.test(match.entryId)
      || typeof match.policy !== "string" || !GLOSSARY_POLICIES.has(match.policy)
      || typeof match.canonicalForm !== "string" || match.canonicalForm.length === 0
      || !Number.isInteger(match.priority) || /** @type {number} */ (match.priority) < 0 || /** @type {number} */ (match.priority) > 1000) {
      return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
    }
  }
  if (available) {
    const digestInput = { schemaVersion: SCHEMA_VERSION, sourceDigest, glossary, matches };
    if (matchSet.matchSetDigest !== sha256(stableJson(digestInput))) return { valid: false, binding: mcpFailureBinding(sourceDigest), summary: invalidSummary, warnings: [] };
    const spans = Array.isArray(manifest.spans) ? manifest.spans : [];
    const protectMissing = matches.some((match) => match.policy === "protect" && !spans.some((span) => span.start <= match.start && span.end >= match.end));
    if (protectMissing) {
      const binding = bindingFromMatchSet(matchSet);
      return { valid: false, binding, summary: summaryFromBinding(binding), warnings: ["GLOSSARY_PROTECT_MISSING"] };
    }
  }
  const binding = bindingFromMatchSet(matchSet);
  return { valid: true, binding, summary: summaryFromBinding(binding), warnings: /** @type {string[]} */ (matchSet.warnings) };
}

/** @param {string} sourceDigest */
function mcpFailureBinding(sourceDigest) {
  return { schemaVersion: SCHEMA_VERSION, mode: "mcp", status: "unavailable", sourceDigest, glossaryId: null, glossaryVersion: null, glossaryDigest: null, matchSetDigest: null, matchCount: 0, warnings: ["GLOSSARY_UNAVAILABLE"] };
}

/** @param {Record<string, unknown>} matchSet */
function bindingFromMatchSet(matchSet) {
  const glossary = matchSet.glossary && typeof matchSet.glossary === "object" ? /** @type {Record<string, unknown>} */ (matchSet.glossary) : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: "mcp",
    status: matchSet.status,
    sourceDigest: matchSet.sourceDigest,
    glossaryId: glossary?.id ?? null,
    glossaryVersion: glossary?.version ?? null,
    glossaryDigest: glossary?.contentDigest ?? null,
    matchSetDigest: matchSet.matchSetDigest,
    matchCount: /** @type {unknown[]} */ (matchSet.matches).length,
    warnings: matchSet.warnings,
  };
}

/** @param {Record<string, unknown>} binding */
function summaryFromBinding(binding) {
  return { mode: binding.mode, status: binding.status, id: binding.glossaryId, version: binding.glossaryVersion, contentDigest: binding.glossaryDigest, matchSetDigest: binding.matchSetDigest, matchCount: binding.matchCount, warnings: binding.warnings };
}

/** @param {Record<string, unknown>} manifest @param {string} source */
function validProtectedManifest(manifest, source) {
  if (!hasExactKeys(manifest, ["schemaVersion", "sourceDigest", "sourceLength", "spans"]) || manifest.schemaVersion !== SCHEMA_VERSION || manifest.sourceDigest !== sha256(source) || manifest.sourceLength !== source.length || !Array.isArray(manifest.spans)) return false;
  const ids = new Set();
  let previousEnd = 0;
  for (const span of manifest.spans) {
    if (!span || typeof span !== "object" || Array.isArray(span) || !hasExactKeys(span, ["id", "kind", "start", "end", "text", "digest"])) return false;
    const item = /** @type {Record<string, unknown>} */ (span);
    if (typeof item.id !== "string" || !/^span-[0-9]{4}$/u.test(item.id) || ids.has(item.id) || typeof item.kind !== "string" || !PROTECTED_KINDS.has(item.kind) || !Number.isInteger(item.start) || !Number.isInteger(item.end)) return false;
    const start = /** @type {number} */ (item.start);
    const end = /** @type {number} */ (item.end);
    if (start < previousEnd || end <= start || end > source.length || typeof item.text !== "string" || item.text !== source.slice(start, end) || item.digest !== sha256(item.text)) return false;
    ids.add(item.id);
    previousEnd = end;
  }
  return true;
}

/** @param {Record<string, unknown>} selection @param {string} sourceDigest @param {string} actorId @param {Map<string, SourceUnit>} unitById @param {string} source */
function validSelection(selection, sourceDigest, actorId, unitById, source, glossaryBinding) {
  if (!hasExactKeys(selection, ["schemaVersion", "actorId", "sourceDigest", "glossaryBinding", "status", "decisions"])) return false;
  if (selection.schemaVersion !== SCHEMA_VERSION || selection.actorId !== actorId || selection.sourceDigest !== sourceDigest || stableJson(selection.glossaryBinding) !== stableJson(glossaryBinding) || !["ready", "needs-input", "blocked"].includes(/** @type {string} */ (selection.status)) || !Array.isArray(selection.decisions)) return false;
  if (selection.decisions.length !== unitById.size) return false;
  const seen = new Set();
  for (const rawDecision of selection.decisions) {
    if (!rawDecision || typeof rawDecision !== "object" || Array.isArray(rawDecision) || !hasExactKeys(rawDecision, ["unitId", "action", "reasonCodes", "riskFlags", "additionalProtectedStrings", "issueRanges"])) return false;
    const decision = /** @type {Record<string, unknown>} */ (rawDecision);
    const unit = typeof decision.unitId === "string" ? unitById.get(decision.unitId) : undefined;
    if (!unit || seen.has(decision.unitId) || !["edit", "retain", "defer"].includes(/** @type {string} */ (decision.action))) return false;
    if (unit.kind === "fenced-code" && decision.action === "edit") return false;
    if (!validCodes(decision.reasonCodes) || !validCodes(decision.riskFlags) || !Array.isArray(decision.additionalProtectedStrings) || !Array.isArray(decision.issueRanges)) return false;
    const protectedStrings = decision.additionalProtectedStrings;
    if (new Set(protectedStrings).size !== protectedStrings.length || protectedStrings.some((item) => typeof item !== "string" || item.length === 0 || !source.slice(unit.start, unit.end).includes(item))) return false;
    if (decision.action === "edit") {
      if (decision.issueRanges.length === 0 || !validIssueRanges(decision.issueRanges, unit, source)) return false;
      const issueCodes = new Set(decision.issueRanges.map((issue) => issue.reasonCode));
      if (decision.reasonCodes.length !== issueCodes.size || decision.reasonCodes.some((code) => !issueCodes.has(code))) return false;
    } else if (decision.issueRanges.length !== 0) return false;
    seen.add(decision.unitId);
  }
  return true;
}

/** @param {any[]} issues @param {SourceUnit} unit @param {string} source */
function validIssueRanges(issues, unit, source) {
  const seen = new Set();
  for (const issue of issues) {
    if (!issue || typeof issue !== "object" || Array.isArray(issue) || !hasExactKeys(issue, ["start", "end", "reasonCode"])) return false;
    if (!Number.isInteger(issue.start) || !Number.isInteger(issue.end) || issue.start < unit.start || issue.end > unit.end || issue.end <= issue.start) return false;
    if (!isUtf16Boundary(source, issue.start) || !isUtf16Boundary(source, issue.end) || !ISSUE_CODES.has(issue.reasonCode)) return false;
    const key = `${issue.start}:${issue.end}:${issue.reasonCode}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/** @param {{start:number,end:number}} left @param {{start:number,end:number}} right */
function rangesOverlap(left, right) {
  if (left.start === left.end) return right.start < left.start && left.start < right.end;
  return left.start < right.end && right.start < left.end;
}

/** @param {Record<string, unknown>} editing @param {string} sourceDigest @param {string} selectionDigest @param {string} actorId */
function validEditingRoot(editing, sourceDigest, selectionDigest, actorId, glossaryBinding) {
  return hasExactKeys(editing, ["schemaVersion", "actorId", "sourceDigest", "glossaryBinding", "selectionDigest", "edits", "candidateDigest"])
    && editing.schemaVersion === SCHEMA_VERSION
    && editing.actorId === actorId
    && editing.sourceDigest === sourceDigest
    && stableJson(editing.glossaryBinding) === stableJson(glossaryBinding)
    && editing.selectionDigest === selectionDigest
    && Array.isArray(editing.edits)
    && typeof editing.candidateDigest === "string"
    && DIGEST.test(editing.candidateDigest);
}

/** @param {unknown} rawEdit @param {string} source @param {string} sourceDigest @param {string} actorId @param {Set<string>} ids */
function validEdit(rawEdit, source, sourceDigest, actorId, ids) {
  if (!rawEdit || typeof rawEdit !== "object" || Array.isArray(rawEdit) || !hasExactKeys(rawEdit, ["id", "unitId", "sourceDigest", "start", "end", "replacement", "actorId"])) return false;
  const edit = /** @type {Record<string, unknown>} */ (rawEdit);
  return typeof edit.id === "string" && edit.id.length > 0 && !ids.has(edit.id)
    && typeof edit.unitId === "string"
    && edit.sourceDigest === sourceDigest
    && Number.isInteger(edit.start) && Number.isInteger(edit.end)
    && /** @type {number} */ (edit.start) >= 0
    && /** @type {number} */ (edit.end) >= /** @type {number} */ (edit.start)
    && /** @type {number} */ (edit.end) <= source.length
    && isUtf16Boundary(source, /** @type {number} */ (edit.start))
    && isUtf16Boundary(source, /** @type {number} */ (edit.end))
    && typeof edit.replacement === "string"
    && edit.actorId === actorId;
}

/** @param {string} source @param {number} index */
function isUtf16Boundary(source, index) {
  if (index <= 0 || index >= source.length) return true;
  const before = source.charCodeAt(index - 1);
  const after = source.charCodeAt(index);
  return !(before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF);
}

/** @param {Record<string, unknown>} verification @param {string} sourceDigest @param {string} editingDigest @param {string} actorId */
function validVerificationRoot(verification, sourceDigest, editingDigest, actorId, glossaryBinding) {
  if (!hasExactKeys(verification, ["schemaVersion", "actorId", "sourceDigest", "glossaryBinding", "editingDigest", "rubricDigest", "globalDecision", "decisions", "assessment"])) return false;
  if (verification.schemaVersion !== SCHEMA_VERSION || verification.actorId !== actorId || verification.sourceDigest !== sourceDigest || stableJson(verification.glossaryBinding) !== stableJson(glossaryBinding) || verification.editingDigest !== editingDigest || typeof verification.rubricDigest !== "string" || !DIGEST.test(verification.rubricDigest) || !["continue", "fallback"].includes(/** @type {string} */ (verification.globalDecision)) || !Array.isArray(verification.decisions)) return false;
  if (!verification.assessment || typeof verification.assessment !== "object" || Array.isArray(verification.assessment) || !hasExactKeys(verification.assessment, ["meaningPreservation", "majorMeaningChange", "registerCompliance", "protectedStrings", "terminologyJudgment", "pairPreference"])) return false;
  const assessment = /** @type {Record<string, unknown>} */ (verification.assessment);
  return ["pass", "fail", "uncertain"].includes(/** @type {string} */ (assessment.meaningPreservation))
    && typeof assessment.majorMeaningChange === "boolean"
    && ["pass", "fail", "uncertain"].includes(/** @type {string} */ (assessment.registerCompliance))
    && ["pass", "fail", "uncertain"].includes(/** @type {string} */ (assessment.protectedStrings))
    && ["pass", "fail", "uncertain", "not-applicable"].includes(/** @type {string} */ (assessment.terminologyJudgment))
    && ["candidate", "original", "tie", "neither"].includes(/** @type {string} */ (assessment.pairPreference));
}

/** @param {any} decision */
function validVerificationDecision(decision) {
  return decision && typeof decision === "object" && !Array.isArray(decision)
    && hasExactKeys(decision, ["editId", "decision", "reasonCode", "sourceDefect", "invariantDelta"])
    && typeof decision.editId === "string" && decision.editId.length > 0
    && (decision.decision === "accept" || decision.decision === "retain")
    && typeof decision.reasonCode === "string" && CODE.test(decision.reasonCode)
    && ["GRAMMATICAL_MISMATCH", "NOUN_STACKING", "REDUNDANCY", "TRANSLATIONESE", "UNNECESSARY_META_PROSE", "UNSUPPORTED_EMPHASIS", "USER_FACING_IMPLEMENTATION_JARGON", "NONE"].includes(decision.sourceDefect)
    && ["NONE", "QUANTIFIER_SCOPE", "CONDITION_OR_TENSE", "MODALITY_OR_CERTAINTY", "ACTION_OR_AUTHORITY", "CLAIM_TYPE_OR_STRENGTH", "PREDICATE_ARGUMENT_STRUCTURE", "RHETORICAL_FUNCTION", "ACTOR_OR_TARGET", "TIME", "NEGATION", "CAUSAL_RELATION", "TERMINOLOGY", "UNCERTAIN"].includes(decision.invariantDelta)
    && (decision.decision !== "accept" || (decision.reasonCode === "MEANING_PRESERVED" && decision.sourceDefect !== "NONE" && decision.invariantDelta === "NONE"));
}

/** @param {any} assessment */
function acceptedAssessmentIsSafe(assessment) {
  return assessment.meaningPreservation === "pass"
    && assessment.majorMeaningChange === false
    && assessment.registerCompliance === "pass"
    && assessment.protectedStrings === "pass"
    && (assessment.terminologyJudgment === "pass" || assessment.terminologyJudgment === "not-applicable")
    && assessment.pairPreference === "candidate";
}

/** @param {string} source @param {Edit[]} edits */
function applyEdits(source, edits) {
  let output = source;
  for (const edit of [...edits].sort((left, right) => right.start - left.start || right.end - left.end)) {
    output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
  }
  return output;
}

/** @param {string} source @param {Edit} edit */
function isMinimalEdit(source, edit) {
  const original = source.slice(edit.start, edit.end);
  if (original === edit.replacement) return false;
  if (original.length === 0 || edit.replacement.length === 0) return true;
  const originalCodePoints = Array.from(original);
  const replacementCodePoints = Array.from(edit.replacement);
  return originalCodePoints[0] !== replacementCodePoints[0] && originalCodePoints.at(-1) !== replacementCodePoints.at(-1);
}

/** @param {string} source @param {any} manifest @param {any[]} decisions @param {Map<string, SourceUnit>} unitById */
function addSelectionProtectedStrings(source, manifest, decisions, unitById) {
  const ranges = manifest.spans.map((span) => ({ start: span.start, end: span.end }));
  for (const decision of decisions) {
    const unit = unitById.get(decision.unitId);
    if (!unit) continue;
    for (const value of decision.additionalProtectedStrings) {
      for (let start = source.indexOf(value, unit.start); start !== -1 && start + value.length <= unit.end; start = source.indexOf(value, start + 1)) {
        ranges.push({ start, end: start + value.length });
      }
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start < previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sourceDigest: sha256(source),
    sourceLength: source.length,
    spans: merged.map((range, index) => {
      const text = source.slice(range.start, range.end);
      return { id: `span-${String(index + 1).padStart(4, "0")}`, kind: "user-defined", start: range.start, end: range.end, text, digest: sha256(text) };
    }),
  };
}

/** @param {unknown} value */
function validCodes(value) {
  return Array.isArray(value) && new Set(value).size === value.length && value.every((item) => typeof item === "string" && CODE.test(item));
}

/** @param {object} value @param {string[]} keys */
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
