import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import schema from "../contracts/collaboration-decision.v1.schema.json" with { type: "json" };

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
  // Historical v1.0 decisions remain valid evidence; new planning uses v1.1.
  if (decision.schemaVersion === "1.0.0") {
    if (decision.auditSeparationRequired) return decision.userDirective === "require" ? "needs-input" : "audit-only";
    if (decision.sourceOriginKind !== "user-turn" || decision.userDirective === "forbid") return "direct";
    if (decision.userDirective === "require") return allBenefitsHold ? "delegate" : "needs-input";
    return allBenefitsHold ? "delegate" : "direct";
  }
  const localRoute = decision.auditSeparationRequired ? "audit-only" : "direct";
  if (decision.sourceOriginKind !== "user-turn") return localRoute;
  if (decision.userDirective === "forbid") return localRoute;
  if (decision.userDirective === "require") {
    const feasible = decision.netBenefitCriteria.independentlyCompletable
      && decision.netBenefitCriteria.singleWriterOwnership
      && (decision.netBenefitCriteria.limitedContextSufficient || decision.fullHistoryContext?.sufficient === true);
    return feasible ? "delegate" : "needs-input";
  }
  return allBenefitsHold ? "delegate" : localRoute;
}

export function validateCollaborationDecision(decision) {
  if (!validateSchema(decision)) return (validateSchema.errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message}`);
  const expectedRoute = deriveCollaborationRoute(decision);
  return decision.route === expectedRoute ? [] : [`route must be ${expectedRoute} for the declared directive, benefit criteria, and audit separation.`];
}

export function collaborationDecisionStructuralDiagnostic(decision) {
  const errors = validateCollaborationDecision(decision);
  return {
    scope: "structural-only",
    valid: errors.length === 0,
    errors,
    diagnostic: "This check validates the schema and deterministic route only; it does not read or authenticate source receipts.",
  };
}
