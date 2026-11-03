#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

function contractError(key, params = {}, details = null) {
  const error = new Error(hostText(key, params));
  error.code = "INVALID_INPUT";
  error.details = details;
  return error;
}

async function compileValidation() {
  const schemas = {
    envelope: await json("../../contracts/task-envelope.v1.schema.json"),
    evidence: await json("contracts/acceptance-evidence-plan.v1.schema.json"),
    request: await json("contracts/task-contract-request.v1.schema.json"),
    report: await json("contracts/task-contract-report.v1.schema.json"),
    validation: await json("contracts/task-contract-validation.v1.schema.json"),
  };
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  for (const schema of [schemas.envelope, schemas.evidence, schemas.request, schemas.report]) ajv.addSchema(schema);
  return ajv.compile(schemas.validation);
}

export function isRepoRelativePosixPath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.trim() !== value || value.includes("//")) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  if (/[*?\[\]{}!]/u.test(value)) return false;
  const segments = value.split("/").filter(Boolean);
  return segments.length > 0 && segments.every((segment) => segment !== "." && segment !== "..");
}

function normalizedPath(value, caseInsensitive = false) {
  const normalized = value.replace(/\/+$/u, "");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function pathsOverlap(first, second, caseInsensitive = false) {
  const a = normalizedPath(first, caseInsensitive);
  const b = normalizedPath(second, caseInsensitive);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function assertUniqueWorkUnitGraph(envelope) {
  const graph = new Map();
  for (const unit of envelope.workUnits) {
    if (graph.has(unit.id)) throw contractError("skillTools.taskContract.workUnitIdsUnique", {}, { workUnitId: unit.id });
    graph.set(unit.id, unit.dependencies);
  }
  for (const unit of envelope.workUnits) {
    for (const dependency of unit.dependencies) {
      if (!graph.has(dependency)) throw contractError("skillTools.taskContract.dependencyMissing", {}, { workUnitId: unit.id, dependency });
      if (dependency === unit.id) throw contractError("skillTools.taskContract.selfDependency", {}, { workUnitId: unit.id });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw contractError("skillTools.taskContract.dependencyCycle", {}, { workUnitId: id });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function assertNoOverlap(first, second, messageKey, caseInsensitive = true) {
  const normalize = (item) => caseInsensitive ? item.trim().toLowerCase() : item.trim();
  const normalizedSecond = new Set(second.map(normalize));
  const overlaps = first.filter((item) => normalizedSecond.has(normalize(item)));
  if (overlaps.length > 0) throw contractError(messageKey, {}, { overlaps });
}

function assertAuthorizationBound(request, report) {
  const authorization = report.taskEnvelope.authorization;
  const actionKey = (value) => value.trim().toLowerCase();
  const groups = [
    { field: "/authorization/allowedActions", effect: "allow", actions: authorization.allowedActions },
    { field: "/authorization/prohibitedActions", effect: "prohibit", actions: authorization.prohibitedActions },
    { field: "/authorization/approvalRequired", effect: "require-approval", actions: authorization.approvalRequired },
  ];
  for (const evidence of request.authorizationEvidence) {
    if (evidence.sourceReceiptId !== undefined && evidence.effect !== "prohibit") {
      throw contractError("skillTools.taskContract.receiptCannotAuthorize", {}, {
        action: evidence.action,
        effect: evidence.effect,
        sourceReceiptId: evidence.sourceReceiptId,
      });
    }
    if (evidence.effect === "allow" && evidence.authority === "project-instruction" && !request.instructionResolutionRefs.includes(evidence.sourceLocator)) {
      throw contractError("skillTools.taskContract.projectGrantUnbound", {}, { action: evidence.action, sourceLocator: evidence.sourceLocator });
    }
    if (evidence.effect !== "allow") {
      const group = groups.find((candidate) => candidate.effect === evidence.effect);
      if (!group.actions.some((action) => actionKey(action) === actionKey(evidence.action))) {
        throw contractError("skillTools.taskContract.restrictiveEvidenceOmitted", {}, { action: evidence.action, effect: evidence.effect });
      }
    }
  }
  for (const group of groups) {
    const uniqueActions = new Set(group.actions.map(actionKey));
    if (uniqueActions.size !== group.actions.length) {
      throw contractError("skillTools.taskContract.actionsNotUnique", {}, { envelopeField: group.field });
    }
  }
  const expectedCount = groups.reduce((count, group) => count + group.actions.length, 0);
  if (report.authorizationProvenance.length !== expectedCount) {
    throw contractError("skillTools.taskContract.provenanceBindingExactlyOne", {}, { expectedCount, actualCount: report.authorizationProvenance.length });
  }

  const used = new Set();
  for (const group of groups) {
    for (const action of group.actions) {
      if (group.effect === "allow" && request.authorizationEvidence.some((evidence) => actionKey(evidence.action) === actionKey(action) && evidence.effect !== "allow")) {
        throw contractError("skillTools.taskContract.allowedConflictsRestrictive", {}, { action });
      }
      const bindings = report.authorizationProvenance
        .map((binding, index) => ({ binding, index }))
        .filter(({ binding }) => binding.action === action && binding.envelopeField === group.field && binding.effect === group.effect);
      if (bindings.length !== 1) {
        throw contractError("skillTools.taskContract.provenanceBindingExactlyOne", {}, { action, envelopeField: group.field, bindingCount: bindings.length });
      }
      const { binding, index } = bindings[0];
      if (used.has(index)) throw contractError("skillTools.taskContract.bindingCoversMultiple", {}, { action });
      used.add(index);
      const evidenceMatches = request.authorizationEvidence.filter((evidence) =>
        evidence.action === action &&
        evidence.effect === binding.effect &&
        evidence.authority === binding.authority &&
        evidence.sourceLocator === binding.sourceLocator &&
        evidence.sourceReceiptId === binding.sourceReceiptId
      );
      if (evidenceMatches.length !== 1) {
        throw contractError("skillTools.taskContract.provenanceMatchExactlyOne", {}, { action, evidenceMatches: evidenceMatches.length });
      }
    }
  }
  if (used.size !== report.authorizationProvenance.length) {
    throw contractError("skillTools.taskContract.provenanceExtraAction");
  }
}

function criterionId(statement) {
  return /^\[(AC-[0-9]{3,})\](?:\s|$)/u.exec(statement)?.[1] ?? null;
}

export async function validateTaskContract(input) {
  const validate = await compileValidation();
  if (!validate(input)) throw contractError("skillTools.taskContract.schemaValidationFailed", {}, { errors: validate.errors });
  const { request, report } = input;
  const envelope = report.taskEnvelope;
  if (request.taskId !== envelope.taskId) throw contractError("skillTools.taskContract.taskIdMismatch");
  const caseInsensitivePaths = request.pathSemantics === "windows";

  assertUniqueWorkUnitGraph(envelope);
  assertNoOverlap(envelope.scope.included, envelope.scope.excluded, "skillTools.taskContract.scopeOverlapExact", caseInsensitivePaths);
  for (const included of envelope.scope.included.filter(isRepoRelativePosixPath)) {
    const excluded = envelope.scope.excluded.filter(isRepoRelativePosixPath).find((item) => pathsOverlap(included, item, caseInsensitivePaths));
    if (excluded) throw contractError("skillTools.taskContract.scopePathOverlap", {}, { included, excluded });
  }
  assertNoOverlap(envelope.authorization.allowedActions, envelope.authorization.prohibitedActions, "skillTools.taskContract.allowedProhibitedOverlap");
  assertNoOverlap(envelope.authorization.allowedActions, envelope.authorization.approvalRequired, "skillTools.taskContract.allowedApprovalOverlap");
  assertNoOverlap(envelope.authorization.prohibitedActions, envelope.authorization.approvalRequired, "skillTools.taskContract.prohibitedApprovalOverlap");
  assertAuthorizationBound(request, report);
  const excludedPaths = envelope.scope.excluded.filter(isRepoRelativePosixPath);
  for (const unit of envelope.workUnits) {
    for (const target of unit.writeTargets) {
      if (!isRepoRelativePosixPath(target)) throw contractError("skillTools.taskContract.writeTargetsFormat", {}, { target });
      const excluded = excludedPaths.find((item) => pathsOverlap(target, item, caseInsensitivePaths));
      if (excluded) throw contractError("skillTools.taskContract.writeTargetExcluded", {}, { target, excluded });
    }
  }

  const envelopeCriteria = new Map();
  for (const statement of envelope.acceptanceCriteria) {
    const id = criterionId(statement);
    if (!id) throw contractError("skillTools.taskContract.criterionIdMissing", {}, { statement });
    if (envelopeCriteria.has(id)) throw contractError("skillTools.taskContract.criterionIdsUnique", {}, { criterionId: id });
    envelopeCriteria.set(id, statement);
  }
  const planCriteria = new Map();
  for (const criterion of report.acceptanceEvidencePlan.criteria) {
    if (planCriteria.has(criterion.criterionId)) throw contractError("skillTools.taskContract.planCriterionIdsUnique", {}, { criterionId: criterion.criterionId });
    planCriteria.set(criterion.criterionId, criterion);
  }
  if (envelopeCriteria.size !== planCriteria.size) throw contractError("skillTools.taskContract.criteriaOneToOne");
  for (const [id, statement] of envelopeCriteria) {
    const planned = planCriteria.get(id);
    if (!planned || planned.statement !== statement) {
      throw contractError("skillTools.taskContract.criterionStatementMismatch", {}, { criterionId: id });
    }
  }

  const requiredProvenance = ["/objective", "/scope", "/riskLevel", "/authorization"];
  for (const field of requiredProvenance) {
    if (!report.provenance.some((item) => item.field === field || item.field.startsWith(`${field}/`))) {
      throw contractError("skillTools.taskContract.coreFieldNoProvenance", {}, { field });
    }
  }

  if (report.verdict === "PASS" && report.ambiguities.some((item) => item.blocking)) {
    throw contractError("skillTools.taskContract.passBlockingAmbiguity");
  }
  if (report.verdict === "PASS" && report.contradictions.length > 0) {
    throw contractError("skillTools.taskContract.passContradictions");
  }
  if (report.verdict === "PASS" && report.assumptions.some((item) => item.impact === "material" && item.confirmationRequired)) {
    throw contractError("skillTools.taskContract.passMaterialAssumption");
  }
  return report;
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) {
    if (!argv[index + 1]) throw contractError("skillTools.taskContract.inputNeedsPath");
    return JSON.parse(await readFile(argv[index + 1], "utf8"));
  }
  let body = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) body += chunk;
  if (!body.trim()) throw contractError("skillTools.taskContract.inputExpected");
  return JSON.parse(body);
}

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const output = await validateTaskContract(await readInput(argv));
    process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0.0", ok: true, output, error: null })}\n`);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      schemaVersion: "1.0.0",
      ok: false,
      output: null,
      error: {
        code: error.code ?? "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
        details: error.details ?? null,
      },
    })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
