import { checkResult } from "./result-checker.mjs";
import { overlapsProtectedSpan } from "./protected-spans.mjs";
import { ContractError, SCHEMA_VERSION, requireObject, sha256, stableJson } from "./lib.mjs";
import { validateProviderPlan } from "./provider-plan.mjs";

/** @typedef {{id: string, sourceDigest: string, start: number, end: number, replacement: string, actorId: string}} Edit */
/** @typedef {{editId: string, decision: "accept" | "retain", reasonCode: string}} VerificationDecision */

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
  const plan = validateProviderPlan(request.plan, { subagentsAvailable: request.subagentsAvailable === true });
  const actorIds = plan.actorIds;
  const manifest = requireObject(request.manifest, "manifest");
  const warnings = new Set();
  /** @type {Edit[]} */
  const edits = [];
  let fallback = false;

  if (manifest.sourceDigest !== sha256(source) || manifest.sourceLength !== source.length || !Array.isArray(manifest.spans)) {
    warnings.add("SOURCE_MANIFEST_MISMATCH");
    fallback = true;
  }

  if (!Array.isArray(request.edits)) throw new ContractError("EDITS", "edits must be an array");
  const editIds = new Set();
  for (const rawEdit of request.edits) {
    const edit = requireObject(rawEdit, "edit");
    if (
      typeof edit.id !== "string" || edit.id.length === 0 || editIds.has(edit.id) ||
      !Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > source.length ||
      typeof edit.replacement !== "string" || edit.sourceDigest !== sha256(source) || edit.actorId !== actorIds[1]
    ) {
      warnings.add("EDIT_CONTRACT_INVALID");
      fallback = true;
      continue;
    }
    editIds.add(edit.id);
    edits.push(/** @type {Edit} */ (edit));
  }
  edits.sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].start < edits[index - 1].end) {
      warnings.add("EDIT_RANGES_OVERLAP");
      fallback = true;
    }
  }

  const verification = requireObject(request.verification, "verification");
  if (verification.actorId !== actorIds[2] || (verification.globalDecision !== "continue" && verification.globalDecision !== "fallback")) {
    warnings.add("VERIFICATION_CONTRACT_INVALID");
    fallback = true;
  }
  if (verification.globalDecision === "fallback") {
    warnings.add("VERIFIER_GLOBAL_FALLBACK");
    fallback = true;
  }
  if (!Array.isArray(verification.decisions)) throw new ContractError("VERIFICATION_DECISIONS", "verification decisions must be an array");

  /** @type {Map<string, VerificationDecision>} */
  const decisionByEdit = new Map();
  for (const rawDecision of verification.decisions) {
    const decision = requireObject(rawDecision, "verification decision");
    if (
      typeof decision.editId !== "string" ||
      (decision.decision !== "accept" && decision.decision !== "retain") ||
      typeof decision.reasonCode !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(decision.reasonCode) ||
      decisionByEdit.has(decision.editId)
    ) {
      warnings.add("VERIFICATION_DECISION_INVALID");
      fallback = true;
      continue;
    }
    decisionByEdit.set(decision.editId, /** @type {VerificationDecision} */ (decision));
  }

  /** @type {Edit[]} */
  const accepted = [];
  /** @type {Edit[]} */
  const retained = [];
  const spans = /** @type {{start: number, end: number}[]} */ (manifest.spans ?? []);
  for (const edit of edits) {
    const decision = decisionByEdit.get(edit.id);
    if (decision?.decision !== "accept") {
      retained.push(edit);
      if (!decision) warnings.add("VERIFICATION_DECISION_MISSING");
      continue;
    }
    if (overlapsProtectedSpan(edit.start, edit.end, spans)) {
      retained.push(edit);
      warnings.add("PROTECTED_EDIT_RETAINED");
      continue;
    }
    accepted.push(edit);
  }

  let output = source;
  if (!fallback) {
    for (const edit of [...accepted].sort((left, right) => right.start - left.start)) {
      output = `${output.slice(0, edit.start)}${edit.replacement}${output.slice(edit.end)}`;
    }
    const check = checkResult(source, output, manifest);
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
      source: sha256(source),
      result: sha256(output),
      manifest: sha256(stableJson(manifest)),
    },
    length: { source: source.length, result: output.length },
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
