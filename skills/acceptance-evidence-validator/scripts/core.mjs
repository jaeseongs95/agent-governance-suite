import { createHash } from "node:crypto";
import { validateInputSchema, validateReportSchema, validateReportValidationSchema, validateTaskEnvelopeSchema } from "./schema-validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

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
  throw new InputError(hostText("skillScripts.acceptanceEvidence.nonJsonValue"));
}

export function sha256(value) {
  return `sha256:${createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex")}`;
}

export function authorityEvidenceDigest(evidence, authorityValue) {
  return sha256({
    id: evidence.id,
    kind: evidence.kind,
    locator: evidence.locator,
    targetDigest: evidence.targetDigest,
    verified: evidence.verified,
    criterionIds: evidence.criterionIds,
    direction: evidence.direction,
    observedResult: evidence.observedResult,
    authorityValue,
  });
}

function nonEmptyString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) throw new InputError(hostText("skillScripts.acceptanceEvidence.mustBeNonEmptyString", { name }));
}

function stringArray(value, name, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new InputError(hostText("skillScripts.acceptanceEvidence.mustBeStringArray", { name }));
  }
  if (new Set(value).size !== value.length) throw new InputError(hostText("skillScripts.acceptanceEvidence.mustNotDuplicate", { name }));
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(hostText("skillScripts.acceptanceEvidence.mustBeObject", { name }));
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new InputError(hostText("skillScripts.acceptanceEvidence.unsupportedFields", { name, fields: extras.join(", ") }));
}

export function assertTaskEnvelope(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new InputError(hostText("skillScripts.acceptanceEvidence.taskEnvelopeNotObject"));
  if (!validateTaskEnvelopeSchema(task)) throw new InputError(hostText("skillScripts.acceptanceEvidence.taskEnvelopeSchemaFailed"), { errors: structuredClone(validateTaskEnvelopeSchema.errors) });
  if (task.schemaVersion !== "1.0.0") throw new InputError(hostText("skillScripts.acceptanceEvidence.taskEnvelopeSchemaVersion"));
  nonEmptyString(task.taskId, "taskEnvelope.taskId");
  nonEmptyString(task.objective, "taskEnvelope.objective");
  exactKeys(task.scope, ["included", "excluded"], "taskEnvelope.scope");
  stringArray(task.scope.included, "taskEnvelope.scope.included");
  stringArray(task.scope.excluded, "taskEnvelope.scope.excluded");
  stringArray(task.acceptanceCriteria, "taskEnvelope.acceptanceCriteria", { min: 1 });
  if (!["low", "medium", "high", "critical"].includes(task.riskLevel)) throw new InputError(hostText("skillScripts.acceptanceEvidence.taskEnvelopeRiskLevel"));
  if (!Array.isArray(task.workUnits)) throw new InputError(hostText("skillScripts.acceptanceEvidence.workUnitsNotArray"));
  const workUnitIds = new Set();
  for (const unit of task.workUnits) {
    exactKeys(unit, ["id", "objective", "dependencies", "writeTargets"], "taskEnvelope.workUnit");
    nonEmptyString(unit.id, "taskEnvelope.workUnit.id");
    if (workUnitIds.has(unit.id)) throw new InputError(hostText("skillScripts.acceptanceEvidence.duplicateWorkUnit", { id: unit.id }));
    workUnitIds.add(unit.id);
    nonEmptyString(unit.objective, `taskEnvelope.workUnit ${unit.id} objective`);
    stringArray(unit.dependencies, `taskEnvelope.workUnit ${unit.id} dependencies`);
    stringArray(unit.writeTargets, `taskEnvelope.workUnit ${unit.id} writeTargets`);
  }
  for (const unit of task.workUnits) {
    for (const dependency of unit.dependencies) if (!workUnitIds.has(dependency)) throw new InputError(hostText("skillScripts.acceptanceEvidence.unknownDependency", { dependency }));
  }
  const graph = new Map(task.workUnits.map((unit) => [unit.id, unit.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new InputError(hostText("skillScripts.acceptanceEvidence.dependencyCycle", { id }));
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  stringArray(task.requiredCapabilities, "taskEnvelope.requiredCapabilities");
  stringArray(task.constraints, "taskEnvelope.constraints");
  exactKeys(task.authorization, ["allowedActions", "prohibitedActions", "approvalRequired"], "taskEnvelope.authorization");
  for (const key of ["allowedActions", "prohibitedActions", "approvalRequired"]) stringArray(task.authorization[key], `taskEnvelope.authorization.${key}`);
  exactKeys(task.decision, ["complexity", "hasConflicts"], "taskEnvelope.decision");
  if (!["simple", "complex"].includes(task.decision.complexity) || typeof task.decision.hasConflicts !== "boolean") {
    throw new InputError(hostText("skillScripts.acceptanceEvidence.taskEnvelopeDecision"));
  }
  exactKeys(task.orchestration, ["requested", "mcpAvailable"], "taskEnvelope.orchestration");
  if (typeof task.orchestration.requested !== "boolean" || typeof task.orchestration.mcpAvailable !== "boolean") {
    throw new InputError(hostText("skillScripts.acceptanceEvidence.taskEnvelopeOrchestration"));
  }
}

function criterionId(statement) {
  return `AC-${createHash("sha256").update(statement, "utf8").digest("hex").slice(0, 12)}`;
}

export function analyzeAcceptance(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError(hostText("skillScripts.acceptanceEvidence.inputNotObject"));
  if (!validateInputSchema(input)) throw new InputError(hostText("skillScripts.acceptanceEvidence.inputSchemaFailed"), { errors: structuredClone(validateInputSchema.errors) });
  if (input.schemaVersion !== "1.0.0") throw new InputError(hostText("skillScripts.acceptanceEvidence.schemaVersion"));
  exactKeys(input, ["schemaVersion", "taskEnvelope", "target", "evidence", "verificationCommands", "knownLimitations", "criterionOverrides", "criterionBindings"], "input");
  assertTaskEnvelope(input.taskEnvelope);
  if (!input.target || typeof input.target !== "object") throw new InputError(hostText("skillScripts.acceptanceEvidence.targetRequired"));
  exactKeys(input.target, ["kind", "identifier", "digest"], "target");
  for (const key of ["kind", "identifier", "digest"]) nonEmptyString(input.target[key], `target.${key}`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.target.digest)) throw new InputError(hostText("skillScripts.acceptanceEvidence.targetDigestSha256"));
  if (!Array.isArray(input.evidence)) throw new InputError(hostText("skillScripts.acceptanceEvidence.evidenceNotArray"));
  if (!Array.isArray(input.verificationCommands)) throw new InputError(hostText("skillScripts.acceptanceEvidence.verificationCommandsNotArray"));
  stringArray(input.knownLimitations, "knownLimitations");
  if (!Array.isArray(input.criterionOverrides)) throw new InputError(hostText("skillScripts.acceptanceEvidence.criterionOverridesNotArray"));

  const validCriterionIds = input.taskEnvelope.acceptanceCriteria.map(criterionId);
  stringArray(validCriterionIds, "criterionIds", { min: 1 });
  const validSet = new Set(validCriterionIds);
  const aliases = new Map();
  const boundStatements = new Set();
  for (const binding of input.criterionBindings ?? []) {
    if (!input.taskEnvelope.acceptanceCriteria.includes(binding.statement)) {
      throw new InputError(hostText("skillScripts.acceptanceEvidence.criteriaMismatch"), { code: "CRITERION_BINDING_STATEMENT_MISMATCH", binding });
    }
    if (aliases.has(binding.criterionId) || boundStatements.has(binding.statement)) {
      throw new InputError(hostText("skillScripts.acceptanceEvidence.mustNotDuplicate", { name: "criterionBindings" }));
    }
    const id = criterionId(binding.statement);
    if (validSet.has(binding.criterionId) && binding.criterionId !== id) {
      throw new InputError(hostText("skillScripts.acceptanceEvidence.criteriaMismatch"), { code: "CRITERION_BINDING_ID_COLLISION", binding });
    }
    aliases.set(binding.criterionId, id);
    boundStatements.add(binding.statement);
  }
  const unboundLegacyIds = new Set();
  const resolveCriterion = (id, subject) => {
    if (validSet.has(id)) return id;
    if (aliases.has(id)) return aliases.get(id);
    // Legacy inputs remain readable, but an array position does not identify a statement.
    if (/^AC-[0-9]{3,}$/u.test(id) && Number(id.slice(3)) >= 1 && Number(id.slice(3)) <= validSet.size) {
      unboundLegacyIds.add(id);
      return null;
    }
    throw new InputError(hostText("skillScripts.acceptanceEvidence.evidenceUnknownCriterion", { evidenceId: subject, criterionId: id }));
  };
  const resolveCriteria = (ids, subject) => [...new Set(ids.map((id) => resolveCriterion(id, subject)).filter((id) => id !== null))];
  const evidenceIds = new Set();
  for (const evidence of input.evidence) {
    exactKeys(evidence, ["id", "kind", "locator", "digest", "targetDigest", "verified", "criterionIds", "direction", "observedResult"], `evidence ${evidence?.id ?? "unknown"}`);
    nonEmptyString(evidence.id, "evidence.id");
    if (evidenceIds.has(evidence.id)) throw new InputError(hostText("skillScripts.acceptanceEvidence.duplicateEvidence", { id: evidence.id }));
    evidenceIds.add(evidence.id);
    nonEmptyString(evidence.locator, `evidence ${evidence.id} locator`);
    nonEmptyString(evidence.digest, `evidence ${evidence.id} digest`);
    nonEmptyString(evidence.targetDigest, `evidence ${evidence.id} targetDigest`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(evidence.digest) || !/^sha256:[a-f0-9]{64}$/u.test(evidence.targetDigest)) throw new InputError(hostText("skillScripts.acceptanceEvidence.evidenceDigestsSha256", { id: evidence.id }));
    if (!["user-input", "file", "test", "document", "tool"].includes(evidence.kind)) throw new InputError(hostText("skillScripts.acceptanceEvidence.evidenceKind", { id: evidence.id }));
    if (typeof evidence.verified !== "boolean") throw new InputError(hostText("skillScripts.acceptanceEvidence.evidenceVerified", { id: evidence.id }));
    if (!["supports", "refutes"].includes(evidence.direction)) throw new InputError(hostText("skillScripts.acceptanceEvidence.evidenceDirection", { id: evidence.id }));
    stringArray(evidence.criterionIds, `evidence ${evidence.id} criterionIds`, { min: 1 });
    for (const id of evidence.criterionIds) resolveCriterion(id, evidence.id);
    nonEmptyString(evidence.observedResult, `evidence ${evidence.id} observedResult`);
  }

  const commandIds = new Set();
  for (const command of input.verificationCommands) {
    exactKeys(command, ["id", "command", "exitCode", "locator", "targetDigest", "criterionIds"], "verificationCommand");
    nonEmptyString(command.id, "verificationCommand.id");
    if (commandIds.has(command.id)) throw new InputError(hostText("skillScripts.acceptanceEvidence.duplicateCommand", { id: command.id }));
    commandIds.add(command.id);
    if (evidenceIds.has(`command:${command.id}`)) throw new InputError(hostText("skillScripts.acceptanceEvidence.reservedCommandEvidenceId", { id: command.id }));
    nonEmptyString(command.command, "verificationCommand.command");
    if (!Number.isInteger(command.exitCode)) throw new InputError(hostText("skillScripts.acceptanceEvidence.commandExitCode"));
    nonEmptyString(command.locator, "verificationCommand.locator");
    if (!/^sha256:[a-f0-9]{64}$/u.test(command.targetDigest ?? "")) throw new InputError(hostText("skillScripts.acceptanceEvidence.commandTargetDigest"));
    stringArray(command.criterionIds, `verificationCommand ${command.id} criterionIds`, { min: 1 });
    for (const id of command.criterionIds) resolveCriterion(id, `command:${command.id}`);
  }

  const overrides = new Map();
  const overrideIds = new Set();
  for (const override of input.criterionOverrides) {
    exactKeys(override, ["criterionId", "status", "rationale", "authorityRef"], `override ${override?.criterionId ?? "unknown"}`);
    const resolvedId = resolveCriterion(override.criterionId, "criterionOverrides");
    if (overrideIds.has(override.criterionId) || overrides.has(resolvedId)) throw new InputError(hostText("skillScripts.acceptanceEvidence.duplicateOverride", { criterionId: override.criterionId }));
    overrideIds.add(override.criterionId);
    if (override.status !== "not-applicable") throw new InputError(hostText("skillScripts.acceptanceEvidence.onlyNotApplicable"));
    nonEmptyString(override.rationale, `override ${override.criterionId} rationale`);
    nonEmptyString(override.authorityRef, `override ${override.criterionId} authorityRef`);
    if (resolvedId !== null) overrides.set(resolvedId, { ...override, criterionId: resolvedId });
  }

  const sourceEvidenceById = new Map(input.evidence.map((item) => [item.id, item]));
  input = {
    ...input,
    evidence: input.evidence.map((item) => ({ ...item, criterionIds: resolveCriteria(item.criterionIds, item.id) })).filter((item) => item.criterionIds.length > 0),
    verificationCommands: input.verificationCommands.map((item) => ({ ...item, criterionIds: resolveCriteria(item.criterionIds, `command:${item.id}`) })).filter((item) => item.criterionIds.length > 0),
  };
  const limitations = [...input.knownLimitations];
  if (unboundLegacyIds.size > 0) limitations.push(`Legacy positional criterion IDs (${[...unboundLegacyIds].join(", ")}) lack exact statement bindings. Supply criterionBindings from the frozen original request/report or collect fresh content-bound evidence.`);
  const currentEvidence = input.evidence.filter((item) => {
    const current = item.targetDigest === input.target.digest;
    if (!current) limitations.push(`Evidence ${item.id} is stale for target ${input.target.identifier}.`);
    return current && item.verified;
  }).map((item) => ({ ...item, evidenceId: item.id }));
  const staleCommandCriteria = new Set();
  const commandEvidence = [];
  for (const command of input.verificationCommands) {
    if (command.targetDigest !== input.target.digest) {
      limitations.push(`Verification command ${command.id} is stale for target ${input.target.identifier}.`);
      for (const id of command.criterionIds) staleCommandCriteria.add(id);
      continue;
    }
    commandEvidence.push({
      evidenceId: `command:${command.id}`,
      kind: "verification-command",
      locator: command.locator,
      digest: sha256({ command: command.command, exitCode: command.exitCode, locator: command.locator, targetDigest: command.targetDigest, criterionIds: command.criterionIds }),
      targetDigest: command.targetDigest,
      criterionIds: [...command.criterionIds],
      direction: command.exitCode === 0 ? "supports" : "refutes",
      observedResult: `Verification command exited with code ${command.exitCode}.`
    });
  }
  const allCurrentEvidence = [...currentEvidence, ...commandEvidence];

  for (const override of overrides.values()) {
    const authority = currentEvidence.find((item) => item.evidenceId === override.authorityRef);
    if (!authority || !["user-input", "document"].includes(authority.kind) || authority.direction !== "supports" || !authority.criterionIds.includes(override.criterionId)) {
      throw new InputError(hostText("skillScripts.acceptanceEvidence.overrideNeedsAuthority", { criterionId: override.criterionId }));
    }
    const match = /^task-envelope#\/(scope\/excluded|authorization\/prohibitedActions)\/([0-9]+)$/u.exec(authority.locator);
    if (!match) throw new InputError(hostText("skillScripts.acceptanceEvidence.overrideAuthorityLocator", { criterionId: override.criterionId }));
    const collection = match[1] === "scope/excluded" ? input.taskEnvelope.scope.excluded : input.taskEnvelope.authorization.prohibitedActions;
    const value = collection[Number(match[2])];
    if (typeof value !== "string" || value.length === 0) throw new InputError(hostText("skillScripts.acceptanceEvidence.overrideLocatorUnresolved", { criterionId: override.criterionId }));
    const expectedDigest = authorityEvidenceDigest(sourceEvidenceById.get(authority.evidenceId), value);
    if (authority.digest !== expectedDigest) throw new InputError(hostText("skillScripts.acceptanceEvidence.overrideDigestMismatch", { criterionId: override.criterionId }));
  }

  const criteria = input.taskEnvelope.acceptanceCriteria.map((statement) => {
    const id = criterionId(statement);
    const override = overrides.get(id);
    const evidence = allCurrentEvidence.filter((item) => item.criterionIds.includes(id));
    const refuting = evidence.filter((item) => item.direction === "refutes");
    const supporting = evidence.filter((item) => item.direction === "supports");
    if (refuting.length > 0) {
      return {
        criterionId: id,
        statement,
        status: "unsatisfied",
        evidenceRefs: refuting.map((item) => item.evidenceId),
        observedResult: refuting.map((item) => item.observedResult).join("; "),
        rationale: "Current target evidence contradicts this acceptance criterion."
      };
    }
    if (unboundLegacyIds.size > 0) {
      return {
        criterionId: id,
        statement,
        status: "insufficient-evidence",
        evidenceRefs: [],
        observedResult: "",
        rationale: "Legacy positional evidence cannot be assigned to exact criterion statements."
      };
    }
    if (override) {
      return {
        criterionId: id,
        statement,
        status: "not-applicable",
        evidenceRefs: [override.authorityRef],
        observedResult: "Excluded by explicit authority.",
        rationale: override.rationale
      };
    }
    if (staleCommandCriteria.has(id)) {
      return {
        criterionId: id,
        statement,
        status: "insufficient-evidence",
        evidenceRefs: [],
        observedResult: "",
        rationale: "A declared verification command does not match the current target."
      };
    }
    if (supporting.length > 0) {
      return {
        criterionId: id,
        statement,
        status: "satisfied",
        evidenceRefs: supporting.map((item) => item.evidenceId),
        observedResult: supporting.map((item) => item.observedResult).join("; "),
        rationale: "Verified evidence for the current target supports this criterion."
      };
    }
    return {
      criterionId: id,
      statement,
      status: "insufficient-evidence",
      evidenceRefs: [],
      observedResult: "",
      rationale: "No verified evidence for the current target supports or refutes this criterion."
    };
  });

  const unresolvedCriteria = criteria.filter((item) => item.status === "insufficient-evidence").map((item) => item.criterionId);
  const verdict = input.taskEnvelope.decision.hasConflicts
    ? "NEEDS_INPUT"
    : criteria.some((item) => item.status === "unsatisfied")
      ? "FAIL"
      : unresolvedCriteria.length > 0 ? "BLOCKED" : "PASS";
  if (input.taskEnvelope.decision.hasConflicts) limitations.push("TaskEnvelope records unresolved conflicts that require input before acceptance can be finalized.");
  const verifiedEvidenceIndex = allCurrentEvidence.map((item) => ({
    evidenceId: item.evidenceId,
    kind: item.kind,
    locator: item.locator,
    digest: item.digest,
    targetDigest: item.targetDigest,
    criterionIds: [...item.criterionIds],
    direction: item.direction
  }));
  return {
    schemaVersion: "1.0.0",
    target: { ...input.target },
    criteria,
    verifiedEvidenceIndex,
    unresolvedCriteria,
    limitations: [...new Set(limitations)],
    verdict
  };
}

export function validateReport(validation) {
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return [hostText("skillScripts.acceptanceEvidence.validationInputNotObject")];
  if (!validateReportValidationSchema(validation)) {
    return [hostText("skillScripts.acceptanceEvidence.validationInputSchemaFailed", { errors: JSON.stringify(validateReportValidationSchema.errors) })];
  }
  const { report, request, requestArtifact } = validation;
  if (!report || typeof report !== "object" || Array.isArray(report)) return [hostText("skillScripts.acceptanceEvidence.reportNotObject")];
  const errors = [];
  if (requestArtifact.digest !== sha256(request)) {
    errors.push(hostText("skillScripts.acceptanceEvidence.requestArtifactDigestMismatch"));
  }
  return [...errors, ...validateReportAgainstRequest(report, request)];
}

/**
 * Canonical report checks against an already frozen request: report schema, self-consistency and one-to-one
 * agreement with analyzeAcceptance(request). Callers that hold the request bytes themselves (the MCP stage gate)
 * use this directly; validateReport adds the requestArtifact digest binding on top.
 */
export function validateReportAgainstRequest(report, request) {
  const errors = [];
  if (!report || typeof report !== "object" || Array.isArray(report)) return [hostText("skillScripts.acceptanceEvidence.reportNotObject")];
  if (!validateReportSchema(report)) errors.push(hostText("skillScripts.acceptanceEvidence.reportSchemaFailed", { errors: JSON.stringify(validateReportSchema.errors) }));
  if (report.schemaVersion !== "1.0.0") errors.push(hostText("skillScripts.acceptanceEvidence.reportSchemaVersion"));
  if (!report.target || typeof report.target.digest !== "string") errors.push(hostText("skillScripts.acceptanceEvidence.reportTargetDigestRequired"));
  if (!Array.isArray(report.criteria) || report.criteria.length === 0) errors.push(hostText("skillScripts.acceptanceEvidence.reportCriteriaEmpty"));
  if (!Array.isArray(report.unresolvedCriteria)) errors.push(hostText("skillScripts.acceptanceEvidence.reportUnresolvedNotArray"));
  if (!Array.isArray(report.limitations)) errors.push(hostText("skillScripts.acceptanceEvidence.reportLimitationsNotArray"));
  if (!Array.isArray(report.verifiedEvidenceIndex)) errors.push(hostText("skillScripts.acceptanceEvidence.reportIndexNotArray"));
  if (!["PASS", "FAIL", "BLOCKED", "NEEDS_INPUT"].includes(report.verdict)) errors.push(hostText("skillScripts.acceptanceEvidence.reportVerdictInvalid"));
  const index = new Map();
  if (Array.isArray(report.verifiedEvidenceIndex)) {
    for (const item of report.verifiedEvidenceIndex) {
      if (index.has(item.evidenceId)) errors.push(hostText("skillScripts.acceptanceEvidence.indexDuplicateEvidence", { evidenceId: item.evidenceId }));
      index.set(item.evidenceId, item);
      if (item.targetDigest !== report.target?.digest) errors.push(hostText("skillScripts.acceptanceEvidence.indexStaleEvidence", { evidenceId: item.evidenceId }));
    }
  }
  if (Array.isArray(report.criteria)) {
    const ids = report.criteria.map((item) => item.criterionId);
    if (new Set(ids).size !== ids.length) errors.push(hostText("skillScripts.acceptanceEvidence.criterionIdsUnique"));
    for (const item of report.criteria) {
      if (!/^AC-[a-f0-9]{12}$/u.test(item.criterionId ?? "")) errors.push(hostText("skillScripts.acceptanceEvidence.criterionIdInvalid", { criterionId: item.criterionId }));
      if (!["satisfied", "unsatisfied", "insufficient-evidence", "not-applicable"].includes(item.status)) errors.push(hostText("skillScripts.acceptanceEvidence.criterionStatusInvalid", { criterionId: item.criterionId }));
      if (item.status === "satisfied" && (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)) errors.push(hostText("skillScripts.acceptanceEvidence.satisfiedWithoutEvidence", { criterionId: item.criterionId }));
      if (item.status === "not-applicable" && (!item.rationale || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)) errors.push(hostText("skillScripts.acceptanceEvidence.notApplicableWithoutAuthority", { criterionId: item.criterionId }));
      for (const ref of item.evidenceRefs ?? []) {
        const evidence = index.get(ref);
        if (!evidence) errors.push(hostText("skillScripts.acceptanceEvidence.evidenceAbsentFromIndex", { criterionId: item.criterionId, ref }));
        else if (!evidence.criterionIds?.includes(item.criterionId)) errors.push(hostText("skillScripts.acceptanceEvidence.evidenceNotBound", { ref, criterionId: item.criterionId }));
        else if (item.status === "satisfied" && evidence.direction !== "supports") errors.push(hostText("skillScripts.acceptanceEvidence.satisfiedNonSupporting", { criterionId: item.criterionId, ref }));
        else if (item.status === "unsatisfied" && evidence.direction !== "refutes") errors.push(hostText("skillScripts.acceptanceEvidence.unsatisfiedNoRefuting", { criterionId: item.criterionId, ref }));
      }
    }
    const hasFailure = report.criteria.some((item) => item.status === "unsatisfied");
    const hasMissing = report.criteria.some((item) => item.status === "insufficient-evidence");
    const expected = hasFailure ? "FAIL" : hasMissing ? "BLOCKED" : "PASS";
    if (report.verdict !== expected && report.verdict !== "NEEDS_INPUT") errors.push(hostText("skillScripts.acceptanceEvidence.verdictMustBe", { verdict: expected }));
    const expectedUnresolved = report.criteria.filter((item) => item.status === "insufficient-evidence").map((item) => item.criterionId).sort();
    const actualUnresolved = Array.isArray(report.unresolvedCriteria) ? [...report.unresolvedCriteria].sort() : [];
    if (canonicalJson(expectedUnresolved) !== canonicalJson(actualUnresolved)) errors.push(hostText("skillScripts.acceptanceEvidence.unresolvedVsStatuses"));
    try {
      const expectedReport = analyzeAcceptance(request);
      if (canonicalJson(expectedReport.target) !== canonicalJson(report.target)) errors.push(hostText("skillScripts.acceptanceEvidence.targetMismatch"));
      if (canonicalJson(expectedReport.criteria) !== canonicalJson(report.criteria)) errors.push(hostText("skillScripts.acceptanceEvidence.criteriaMismatch"));
      if (canonicalJson(expectedReport.verifiedEvidenceIndex) !== canonicalJson(report.verifiedEvidenceIndex)) errors.push(hostText("skillScripts.acceptanceEvidence.indexMismatch"));
      if (canonicalJson(expectedReport.unresolvedCriteria) !== canonicalJson(report.unresolvedCriteria)) errors.push(hostText("skillScripts.acceptanceEvidence.unresolvedMismatch"));
      if (canonicalJson(expectedReport.limitations) !== canonicalJson(report.limitations)) errors.push(hostText("skillScripts.acceptanceEvidence.limitationsMismatch"));
      if (expectedReport.verdict !== report.verdict) errors.push(hostText("skillScripts.acceptanceEvidence.verdictMustBe", { verdict: expectedReport.verdict }));
    } catch (error) {
      errors.push(hostText("skillScripts.acceptanceEvidence.requestCannotSubstantiate", { message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return errors;
}
