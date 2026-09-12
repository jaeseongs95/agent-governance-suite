#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"));
}

function contractError(message, details = null) {
  const error = new Error(message);
  error.code = "INVALID_INPUT";
  error.details = details;
  return error;
}

async function compileValidation() {
  const schemas = {
    envelope: await json("contracts/upstream/task-envelope.v1.schema.json"),
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
    if (graph.has(unit.id)) throw contractError("Work unit IDs must be unique.", { workUnitId: unit.id });
    graph.set(unit.id, unit.dependencies);
  }
  for (const unit of envelope.workUnits) {
    for (const dependency of unit.dependencies) {
      if (!graph.has(dependency)) throw contractError("Work unit dependency does not exist.", { workUnitId: unit.id, dependency });
      if (dependency === unit.id) throw contractError("A work unit cannot depend on itself.", { workUnitId: unit.id });
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw contractError("Work unit dependencies contain a cycle.", { workUnitId: id });
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

function assertNoOverlap(first, second, message, caseInsensitive = true) {
  const normalize = (item) => caseInsensitive ? item.trim().toLowerCase() : item.trim();
  const normalizedSecond = new Set(second.map(normalize));
  const overlaps = first.filter((item) => normalizedSecond.has(normalize(item)));
  if (overlaps.length > 0) throw contractError(message, { overlaps });
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
    if (evidence.effect === "allow" && evidence.authority === "project-instruction") {
      throw contractError("Project instructions cannot expand allowed actions.", { action: evidence.action, sourceLocator: evidence.sourceLocator });
    }
    if (evidence.effect !== "allow") {
      const group = groups.find((candidate) => candidate.effect === evidence.effect);
      if (!group.actions.some((action) => actionKey(action) === actionKey(evidence.action))) {
        throw contractError("Restrictive authorization evidence cannot be omitted from the TaskEnvelope.", { action: evidence.action, effect: evidence.effect });
      }
    }
  }
  for (const group of groups) {
    const uniqueActions = new Set(group.actions.map(actionKey));
    if (uniqueActions.size !== group.actions.length) {
      throw contractError("Authorization actions must be unique under case-insensitive comparison.", { envelopeField: group.field });
    }
  }
  const expectedCount = groups.reduce((count, group) => count + group.actions.length, 0);
  if (report.authorizationProvenance.length !== expectedCount) {
    throw contractError("Every authorization action must have exactly one provenance binding.", { expectedCount, actualCount: report.authorizationProvenance.length });
  }

  const used = new Set();
  for (const group of groups) {
    for (const action of group.actions) {
      if (group.effect === "allow" && request.authorizationEvidence.some((evidence) => actionKey(evidence.action) === actionKey(action) && evidence.effect !== "allow")) {
        throw contractError("An allowed action conflicts with restrictive authority evidence.", { action });
      }
      const bindings = report.authorizationProvenance
        .map((binding, index) => ({ binding, index }))
        .filter(({ binding }) => binding.action === action && binding.envelopeField === group.field && binding.effect === group.effect);
      if (bindings.length !== 1) {
        throw contractError("Every authorization action must have exactly one provenance binding.", { action, envelopeField: group.field, bindingCount: bindings.length });
      }
      const { binding, index } = bindings[0];
      if (used.has(index)) throw contractError("An authorization provenance binding cannot cover more than one action.", { action });
      used.add(index);
      const evidenceMatches = request.authorizationEvidence.filter((evidence) =>
        evidence.action === action &&
        evidence.effect === binding.effect &&
        evidence.authority === binding.authority &&
        evidence.sourceLocator === binding.sourceLocator
      );
      if (evidenceMatches.length !== 1) {
        throw contractError("Authorization provenance must match exactly one request authority record.", { action, evidenceMatches: evidenceMatches.length });
      }
    }
  }
  if (used.size !== report.authorizationProvenance.length) {
    throw contractError("Authorization provenance contains an action not present in the TaskEnvelope.");
  }
}

function criterionId(statement) {
  return /^\[(AC-[0-9]{3,})\](?:\s|$)/u.exec(statement)?.[1] ?? null;
}

export async function validateTaskContract(input) {
  const validate = await compileValidation();
  if (!validate(input)) throw contractError("Task contract schema validation failed.", { errors: validate.errors });
  const { request, report } = input;
  const envelope = report.taskEnvelope;
  if (request.taskId !== envelope.taskId) throw contractError("Request and TaskEnvelope taskId must match.");
  const caseInsensitivePaths = request.pathSemantics === "windows";

  assertUniqueWorkUnitGraph(envelope);
  assertNoOverlap(envelope.scope.included, envelope.scope.excluded, "Included and excluded scope must not overlap exactly.", caseInsensitivePaths);
  for (const included of envelope.scope.included.filter(isRepoRelativePosixPath)) {
    const excluded = envelope.scope.excluded.filter(isRepoRelativePosixPath).find((item) => pathsOverlap(included, item, caseInsensitivePaths));
    if (excluded) throw contractError("Included and excluded path scope must not overlap.", { included, excluded });
  }
  assertNoOverlap(envelope.authorization.allowedActions, envelope.authorization.prohibitedActions, "Allowed and prohibited actions must not overlap.");
  assertNoOverlap(envelope.authorization.allowedActions, envelope.authorization.approvalRequired, "Allowed and approval-required actions must not overlap.");
  assertNoOverlap(envelope.authorization.prohibitedActions, envelope.authorization.approvalRequired, "Prohibited and approval-required actions must not overlap.");
  assertAuthorizationBound(request, report);

  const excludedPaths = envelope.scope.excluded.filter(isRepoRelativePosixPath);
  for (const unit of envelope.workUnits) {
    for (const target of unit.writeTargets) {
      if (!isRepoRelativePosixPath(target)) throw contractError("writeTargets must use repository-relative POSIX paths without globs.", { target });
      const excluded = excludedPaths.find((item) => pathsOverlap(target, item, caseInsensitivePaths));
      if (excluded) throw contractError("A writeTarget overlaps excluded scope.", { target, excluded });
    }
  }

  const envelopeCriteria = new Map();
  for (const statement of envelope.acceptanceCriteria) {
    const id = criterionId(statement);
    if (!id) throw contractError("Every acceptance criterion must start with an AC-001 style ID.", { statement });
    if (envelopeCriteria.has(id)) throw contractError("Acceptance criterion IDs must be unique.", { criterionId: id });
    envelopeCriteria.set(id, statement);
  }
  const planCriteria = new Map();
  for (const criterion of report.acceptanceEvidencePlan.criteria) {
    if (planCriteria.has(criterion.criterionId)) throw contractError("Evidence plan criterion IDs must be unique.", { criterionId: criterion.criterionId });
    planCriteria.set(criterion.criterionId, criterion);
  }
  if (envelopeCriteria.size !== planCriteria.size) throw contractError("Acceptance criteria and evidence plan must be one-to-one.");
  for (const [id, statement] of envelopeCriteria) {
    const planned = planCriteria.get(id);
    if (!planned || planned.statement !== statement) {
      throw contractError("Acceptance criterion and evidence plan statement must match exactly.", { criterionId: id });
    }
  }

  const requiredProvenance = ["/objective", "/scope", "/riskLevel", "/authorization"];
  for (const field of requiredProvenance) {
    if (!report.provenance.some((item) => item.field === field || item.field.startsWith(`${field}/`))) {
      throw contractError("A core field has no provenance.", { field });
    }
  }

  if (report.verdict === "PASS" && report.ambiguities.some((item) => item.blocking)) {
    throw contractError("PASS is invalid while a blocking ambiguity remains.");
  }
  if (report.verdict === "PASS" && report.contradictions.length > 0) {
    throw contractError("PASS is invalid while contradictions remain.");
  }
  if (report.verdict === "PASS" && report.assumptions.some((item) => item.impact === "material" && item.confirmationRequired)) {
    throw contractError("PASS is invalid while a material assumption requires confirmation.");
  }
  return report;
}

async function readInput(argv) {
  const index = argv.indexOf("--input");
  if (index >= 0) {
    if (!argv[index + 1]) throw contractError("--input requires a file path.");
    return JSON.parse(await readFile(argv[index + 1], "utf8"));
  }
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  if (!body.trim()) throw contractError("Expected JSON on stdin or --input <file>.");
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
