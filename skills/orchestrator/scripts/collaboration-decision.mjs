import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(path.join(root, "contracts", "collaboration-decision.v1.schema.json"), "utf8"));
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

const criteriaKeys = [
  "independentlyCompletable",
  "parallelBottleneckReduced",
  "limitedContextSufficient",
  "singleWriterOwnership",
  "netBenefitAfterOverhead",
];

export function deriveCollaborationRoute(decision) {
  const allBenefitsHold = criteriaKeys.every((key) => decision.netBenefitCriteria[key]);
  if (decision.auditSeparationRequired) return decision.userDirective === "require" ? "needs-input" : "audit-only";
  if (decision.sourceOriginKind !== "user-turn") return "direct";
  if (decision.userDirective === "forbid") return "direct";
  if (decision.userDirective === "require") return allBenefitsHold ? "delegate" : "needs-input";
  return allBenefitsHold ? "delegate" : "direct";
}

export function validateCollaborationDecision(decision) {
  if (!validateSchema(decision)) return (validateSchema.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
  const expectedRoute = deriveCollaborationRoute(decision);
  return decision.route === expectedRoute ? [] : [`route must be ${expectedRoute} for the declared directive, benefit criteria, and audit separation.`];
}
