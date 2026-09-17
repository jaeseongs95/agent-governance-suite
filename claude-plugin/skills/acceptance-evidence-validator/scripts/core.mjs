import { createHash } from "node:crypto";
import { validateInputSchema, validateReportSchema, validateReportValidationSchema } from "./schema-validation.mjs";

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
  throw new InputError("Input contains a non-JSON value.");
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
  if (typeof value !== "string" || value.trim().length === 0) throw new InputError(`${name} must be a non-empty string.`);
}

function stringArray(value, name, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new InputError(`${name} must be an array of non-empty strings.`);
  }
  if (new Set(value).size !== value.length) throw new InputError(`${name} must not contain duplicates.`);
}

function exactKeys(value, allowed, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError(`${name} must be an object.`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new InputError(`${name} contains unsupported fields: ${extras.join(", ")}.`);
}

export function assertTaskEnvelope(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new InputError("taskEnvelope must be an object.");
  exactKeys(task, ["schemaVersion", "taskId", "objective", "scope", "acceptanceCriteria", "riskLevel", "workUnits", "requiredCapabilities", "constraints", "authorization", "decision", "orchestration"], "taskEnvelope");
  if (task.schemaVersion !== "1.0.0") throw new InputError("taskEnvelope.schemaVersion must be 1.0.0.");
  nonEmptyString(task.taskId, "taskEnvelope.taskId");
  nonEmptyString(task.objective, "taskEnvelope.objective");
  exactKeys(task.scope, ["included", "excluded"], "taskEnvelope.scope");
  stringArray(task.scope.included, "taskEnvelope.scope.included");
  stringArray(task.scope.excluded, "taskEnvelope.scope.excluded");
  stringArray(task.acceptanceCriteria, "taskEnvelope.acceptanceCriteria", { min: 1 });
  if (!["low", "medium", "high", "critical"].includes(task.riskLevel)) throw new InputError("taskEnvelope.riskLevel is invalid.");
  if (!Array.isArray(task.workUnits)) throw new InputError("taskEnvelope.workUnits must be an array.");
  const workUnitIds = new Set();
  for (const unit of task.workUnits) {
    exactKeys(unit, ["id", "objective", "dependencies", "writeTargets"], "taskEnvelope.workUnit");
    nonEmptyString(unit.id, "taskEnvelope.workUnit.id");
    if (workUnitIds.has(unit.id)) throw new InputError(`Duplicate work unit id: ${unit.id}.`);
    workUnitIds.add(unit.id);
    nonEmptyString(unit.objective, `taskEnvelope.workUnit ${unit.id} objective`);
    stringArray(unit.dependencies, `taskEnvelope.workUnit ${unit.id} dependencies`);
    stringArray(unit.writeTargets, `taskEnvelope.workUnit ${unit.id} writeTargets`);
  }
  for (const unit of task.workUnits) {
    for (const dependency of unit.dependencies) if (!workUnitIds.has(dependency)) throw new InputError(`Unknown work unit dependency: ${dependency}.`);
  }
  const graph = new Map(task.workUnits.map((unit) => [unit.id, unit.dependencies]));
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new InputError(`Work unit dependency cycle at ${id}.`);
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
    throw new InputError("taskEnvelope.decision is invalid.");
  }
  exactKeys(task.orchestration, ["requested", "mcpAvailable"], "taskEnvelope.orchestration");
  if (typeof task.orchestration.requested !== "boolean" || typeof task.orchestration.mcpAvailable !== "boolean") {
    throw new InputError("taskEnvelope.orchestration is invalid.");
  }
}

function criterionId(index) {
  return `AC-${String(index + 1).padStart(3, "0")}`;
}

export function analyzeAcceptance(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InputError("Input must be an object.");
  if (!validateInputSchema(input)) throw new InputError("AcceptanceEvidenceInput.v1 validation failed.", { errors: structuredClone(validateInputSchema.errors) });
  if (input.schemaVersion !== "1.0.0") throw new InputError("schemaVersion must be 1.0.0.");
  exactKeys(input, ["schemaVersion", "taskEnvelope", "target", "evidence", "verificationCommands", "knownLimitations", "criterionOverrides"], "input");
  assertTaskEnvelope(input.taskEnvelope);
  if (!input.target || typeof input.target !== "object") throw new InputError("target is required.");
  exactKeys(input.target, ["kind", "identifier", "digest"], "target");
  for (const key of ["kind", "identifier", "digest"]) nonEmptyString(input.target[key], `target.${key}`);
  if (!/^sha256:[a-f0-9]{64}$/u.test(input.target.digest)) throw new InputError("target.digest must be a sha256 digest.");
  if (!Array.isArray(input.evidence)) throw new InputError("evidence must be an array.");
  if (!Array.isArray(input.verificationCommands)) throw new InputError("verificationCommands must be an array.");
  stringArray(input.knownLimitations, "knownLimitations");
  if (!Array.isArray(input.criterionOverrides)) throw new InputError("criterionOverrides must be an array.");

  const validCriterionIds = input.taskEnvelope.acceptanceCriteria.map((_, index) => criterionId(index));
  const validSet = new Set(validCriterionIds);
  const evidenceIds = new Set();
  for (const evidence of input.evidence) {
    exactKeys(evidence, ["id", "kind", "locator", "digest", "targetDigest", "verified", "criterionIds", "direction", "observedResult"], `evidence ${evidence?.id ?? "unknown"}`);
    nonEmptyString(evidence.id, "evidence.id");
    if (evidenceIds.has(evidence.id)) throw new InputError(`Duplicate evidence id: ${evidence.id}`);
    evidenceIds.add(evidence.id);
    nonEmptyString(evidence.locator, `evidence ${evidence.id} locator`);
    nonEmptyString(evidence.digest, `evidence ${evidence.id} digest`);
    nonEmptyString(evidence.targetDigest, `evidence ${evidence.id} targetDigest`);
    if (!/^sha256:[a-f0-9]{64}$/u.test(evidence.digest) || !/^sha256:[a-f0-9]{64}$/u.test(evidence.targetDigest)) throw new InputError(`evidence ${evidence.id} digests must be sha256 values.`);
    if (!["user-input", "file", "test", "document", "tool"].includes(evidence.kind)) throw new InputError(`evidence ${evidence.id} kind is invalid.`);
    if (typeof evidence.verified !== "boolean") throw new InputError(`evidence ${evidence.id} verified must be boolean.`);
    if (!["supports", "refutes"].includes(evidence.direction)) throw new InputError(`evidence ${evidence.id} direction is invalid.`);
    stringArray(evidence.criterionIds, `evidence ${evidence.id} criterionIds`, { min: 1 });
    for (const id of evidence.criterionIds) if (!validSet.has(id)) throw new InputError(`Evidence ${evidence.id} references unknown criterion ${id}.`);
    nonEmptyString(evidence.observedResult, `evidence ${evidence.id} observedResult`);
  }

  const commandIds = new Set();
  for (const command of input.verificationCommands) {
    exactKeys(command, ["id", "command", "exitCode", "locator", "targetDigest", "criterionIds"], "verificationCommand");
    nonEmptyString(command.id, "verificationCommand.id");
    if (commandIds.has(command.id)) throw new InputError(`Duplicate verificationCommand id: ${command.id}.`);
    commandIds.add(command.id);
    if (evidenceIds.has(`command:${command.id}`)) throw new InputError(`Evidence id command:${command.id} is reserved for a verification command.`);
    nonEmptyString(command.command, "verificationCommand.command");
    if (!Number.isInteger(command.exitCode)) throw new InputError("verificationCommand.exitCode must be an integer.");
    nonEmptyString(command.locator, "verificationCommand.locator");
    if (!/^sha256:[a-f0-9]{64}$/u.test(command.targetDigest ?? "")) throw new InputError("verificationCommand.targetDigest must be a sha256 value.");
    stringArray(command.criterionIds, `verificationCommand ${command.id} criterionIds`, { min: 1 });
    for (const id of command.criterionIds) if (!validSet.has(id)) throw new InputError(`Verification command ${command.id} references unknown criterion ${id}.`);
  }

  const overrides = new Map();
  for (const override of input.criterionOverrides) {
    exactKeys(override, ["criterionId", "status", "rationale", "authorityRef"], `override ${override?.criterionId ?? "unknown"}`);
    if (!validSet.has(override.criterionId)) throw new InputError(`Override references unknown criterion ${override.criterionId}.`);
    if (overrides.has(override.criterionId)) throw new InputError(`Duplicate override for ${override.criterionId}.`);
    if (override.status !== "not-applicable") throw new InputError("Only not-applicable overrides are supported.");
    nonEmptyString(override.rationale, `override ${override.criterionId} rationale`);
    nonEmptyString(override.authorityRef, `override ${override.criterionId} authorityRef`);
    overrides.set(override.criterionId, override);
  }

  const limitations = [...input.knownLimitations];
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
      throw new InputError(`Override ${override.criterionId} must reference verified current authority evidence for that criterion.`);
    }
    const match = /^task-envelope#\/(scope\/excluded|authorization\/prohibitedActions)\/([0-9]+)$/u.exec(authority.locator);
    if (!match) throw new InputError(`Override ${override.criterionId} authority evidence must locate an excluded scope or prohibited action in TaskEnvelope.`);
    const collection = match[1] === "scope/excluded" ? input.taskEnvelope.scope.excluded : input.taskEnvelope.authorization.prohibitedActions;
    const value = collection[Number(match[2])];
    if (typeof value !== "string" || value.length === 0) throw new InputError(`Override ${override.criterionId} authority locator does not resolve in TaskEnvelope.`);
    const expectedDigest = authorityEvidenceDigest(authority, value);
    if (authority.digest !== expectedDigest) throw new InputError(`Override ${override.criterionId} authority evidence digest does not match TaskEnvelope.`);
  }

  const criteria = input.taskEnvelope.acceptanceCriteria.map((statement, index) => {
    const id = criterionId(index);
    const override = overrides.get(id);
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
  const errors = [];
  if (!validation || typeof validation !== "object" || Array.isArray(validation)) return ["validation input must be an object"];
  if (!validateReportValidationSchema(validation)) {
    return [`validation input schema validation failed: ${JSON.stringify(validateReportValidationSchema.errors)}`];
  }
  const { report, request, requestArtifact } = validation;
  const expectedRequestDigest = sha256(request);
  if (requestArtifact.digest !== expectedRequestDigest) {
    errors.push("requestArtifact.digest does not match the canonical frozen request");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return ["report must be an object"];
  if (!validateReportSchema(report)) errors.push(`report schema validation failed: ${JSON.stringify(validateReportSchema.errors)}`);
  if (report.schemaVersion !== "1.0.0") errors.push("report.schemaVersion must be 1.0.0");
  if (!report.target || typeof report.target.digest !== "string") errors.push("report.target.digest is required");
  if (!Array.isArray(report.criteria) || report.criteria.length === 0) errors.push("report.criteria must be non-empty");
  if (!Array.isArray(report.unresolvedCriteria)) errors.push("report.unresolvedCriteria must be an array");
  if (!Array.isArray(report.limitations)) errors.push("report.limitations must be an array");
  if (!Array.isArray(report.verifiedEvidenceIndex)) errors.push("report.verifiedEvidenceIndex must be an array");
  if (!["PASS", "FAIL", "BLOCKED", "NEEDS_INPUT"].includes(report.verdict)) errors.push("report.verdict is invalid");
  const index = new Map();
  if (Array.isArray(report.verifiedEvidenceIndex)) {
    for (const item of report.verifiedEvidenceIndex) {
      if (index.has(item.evidenceId)) errors.push(`verified evidence ID is duplicated: ${item.evidenceId}`);
      index.set(item.evidenceId, item);
      if (item.targetDigest !== report.target?.digest) errors.push(`verified evidence ${item.evidenceId} is stale`);
    }
  }
  if (Array.isArray(report.criteria)) {
    const ids = report.criteria.map((item) => item.criterionId);
    if (new Set(ids).size !== ids.length) errors.push("criterion IDs must be unique");
    for (const item of report.criteria) {
      if (!/^AC-[0-9]{3,}$/u.test(item.criterionId ?? "")) errors.push(`invalid criterion ID: ${item.criterionId}`);
      if (!["satisfied", "unsatisfied", "insufficient-evidence", "not-applicable"].includes(item.status)) errors.push(`invalid status for ${item.criterionId}`);
      if (item.status === "satisfied" && (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)) errors.push(`${item.criterionId} satisfied without evidence`);
      if (item.status === "not-applicable" && (!item.rationale || !Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0)) errors.push(`${item.criterionId} not-applicable without authority`);
      for (const ref of item.evidenceRefs ?? []) {
        const evidence = index.get(ref);
        if (!evidence) errors.push(`${item.criterionId} references evidence absent from verifiedEvidenceIndex: ${ref}`);
        else if (!evidence.criterionIds?.includes(item.criterionId)) errors.push(`${ref} is not bound to ${item.criterionId}`);
        else if (item.status === "satisfied" && evidence.direction !== "supports") errors.push(`${item.criterionId} satisfied with non-supporting evidence ${ref}`);
        else if (item.status === "unsatisfied" && evidence.direction !== "refutes") errors.push(`${item.criterionId} unsatisfied without refuting evidence ${ref}`);
      }
    }
    const hasFailure = report.criteria.some((item) => item.status === "unsatisfied");
    const hasMissing = report.criteria.some((item) => item.status === "insufficient-evidence");
    const expected = hasFailure ? "FAIL" : hasMissing ? "BLOCKED" : "PASS";
    if (report.verdict !== expected && report.verdict !== "NEEDS_INPUT") errors.push(`verdict must be ${expected}`);
    const expectedUnresolved = report.criteria.filter((item) => item.status === "insufficient-evidence").map((item) => item.criterionId).sort();
    const actualUnresolved = Array.isArray(report.unresolvedCriteria) ? [...report.unresolvedCriteria].sort() : [];
    if (canonicalJson(expectedUnresolved) !== canonicalJson(actualUnresolved)) errors.push("unresolvedCriteria does not match criterion statuses");
    try {
      const expectedReport = analyzeAcceptance(request);
      if (canonicalJson(expectedReport.target) !== canonicalJson(report.target)) errors.push("report target does not match request target");
      if (canonicalJson(expectedReport.criteria) !== canonicalJson(report.criteria)) errors.push("report criteria do not match the request-derived criteria and evidence one-to-one");
      if (canonicalJson(expectedReport.verifiedEvidenceIndex) !== canonicalJson(report.verifiedEvidenceIndex)) errors.push("verifiedEvidenceIndex does not exactly match current verified request evidence");
      if (canonicalJson(expectedReport.unresolvedCriteria) !== canonicalJson(report.unresolvedCriteria)) errors.push("unresolvedCriteria does not match request-derived status");
      if (canonicalJson(expectedReport.limitations) !== canonicalJson(report.limitations)) errors.push("limitations do not match request-derived limitations");
      if (expectedReport.verdict !== report.verdict) errors.push(`verdict must be ${expectedReport.verdict}`);
    } catch (error) {
      errors.push(`request cannot substantiate report: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
