import {
  WorkflowContractError, type SemanticDecisionPolicyV1, type SemanticDecisionRequestV1,
  type SemanticEgressConfigV1, type SemanticEgressAccessPathV1, type SemanticEgressDataCategoryV1,
} from "../../../contracts/types.js";
import { canonical, digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ContractValidator } from "../schema-validator.js";
import type { WorkflowStore } from "../workflow-store.js";
import { resolveTaskReference, type TaskReferencePrincipal } from "./task-ref-resolver.js";

type AccessPath = SemanticEgressAccessPathV1;
type DataCategory = SemanticEgressDataCategoryV1;
type Approval = { source: string; revision: number; decisionId: string };

/** Values must be observed by the owning server immediately before a provider call. */
export interface SemanticEgressContext {
  assignment: unknown;
  store: Pick<WorkflowStore, "getGuardedRunSnapshot">;
  principal: Readonly<TaskReferencePrincipal>;
  endpoint: string;
  accessPath: AccessPath | "unknown";
  redirect: "error" | "follow" | "manual";
  approval: (Approval & { approved: true; configDigest: string; paidAccessPaths: AccessPath[] }) | null;
  credential: { providerId: string; endpoint: string; accessPath: AccessPath } | null;
  accounting: {
    evaluationId: string; requestsUsed: number; costUsedMicros: number;
    estimatedCostMicros: number | null; currency: string; basis: "evaluation";
  } | null;
}

function deny(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowContractError("GATE_FAILED", message);
}

function endpoint(value: string): string {
  try {
    const url = new URL(value);
    deny(url.protocol === "https:" && url.href === value && !url.username && !url.password
      && !url.search && !url.hash, "Egress endpoint must be an exact HTTPS URL without credentials or parameters.");
    return url.href;
  } catch {
    throw new WorkflowContractError("GATE_FAILED", "Invalid semantic egress endpoint.");
  }
}

/** Read-only preflight. The caller must atomically reserve budget and use redirect:error at transport time. */
export function assertSemanticEgressAllowed(
  preparedValue: unknown,
  policyValue: unknown,
  configValue: unknown,
  context: Readonly<SemanticEgressContext>,
): { endpoint: string; redirect: "error" } {
  const validator = new ContractValidator();
  const prepared: SemanticDecisionRequestV1 = validator.semanticDecisionRequestV1(preparedValue);
  const policy: SemanticDecisionPolicyV1 = validator.semanticDecisionPolicyV1(policyValue);
  let config: SemanticEgressConfigV1;
  try {
    config = validator.semanticEgressConfigV1(configValue);
  } catch {
    throw new WorkflowContractError("GATE_FAILED", "Semantic egress configuration is invalid or absent.");
  }
  deny(config.enabled && policy.mode !== "off" && prepared.mode === policy.mode
    && prepared.semanticPolicyDigest === digest(policy)
    && policy.egress.enabled && policy.egress.allowedProviders.includes(prepared.provider.id),
  "Semantic policy or server egress configuration is off or mismatched.");
  const assignment = validator.semanticModelAssignmentRequestV1(context.assignment);
  const resolved = resolveTaskReference(assignment, context.store, context.principal);
  deny(canonical(prepared.binding) === canonical(assignment.routingRequest.binding)
    && prepared.effectiveRoutingRequestDigest === digest(assignment.routingRequest)
    && canonical(prepared.state.sources.filter(source => source.id !== "model-catalog"))
      === canonical(resolved.sources),
  "Prepared request is not bound to the current authorized local task and sources.");
  const taskAuthorization = resolved.task.authorization;
  deny(taskAuthorization.allowedActions.includes("network")
    && !taskAuthorization.prohibitedActions.includes("network")
    && !taskAuthorization.approvalRequired.includes("network"),
  "Provider network access is not approved by the current task.");
  const target = endpoint(context.endpoint);
  deny(context.redirect === "error", "Redirects are not authorized.");
  deny(context.accessPath !== "unknown", "Unknown access path cannot authorize egress.");
  const accessPath = context.accessPath;
  const routes = config.routes.filter(route => route.providerId === prepared.provider.id
    && endpoint(route.endpoint) === target && route.accessPaths.includes(accessPath));
  deny(routes.length === 1, "Provider, endpoint, or access path is not uniquely allowed.");
  const categories = new Set<DataCategory>(["routing", "question", "catalog"]);
  for (const source of prepared.state.sources) {
    if (source.kind === "artifact" && source.id === "model-catalog") continue;
    categories.add(source.kind);
  }
  deny([...categories].every(category => routes[0]!.dataCategories.includes(category)),
    "Prepared request includes a disallowed data category.");
  deny(context.approval?.approved === true
    && context.approval.source === config.approval.source
    && context.approval.revision === config.approval.revision
    && context.approval.decisionId === config.approval.decisionId
    && context.approval.configDigest === digest(config),
  "Current server approval does not match the egress configuration.");
  deny(context.accessPath === "subscription" || context.approval.paidAccessPaths.includes(context.accessPath),
    "Paid access path requires explicit approval.");
  deny(context.credential?.providerId === prepared.provider.id
    && context.credential.endpoint === target && context.credential.accessPath === context.accessPath,
  "No matching provider credential is available.");
  const budget = config.budget, accounting = context.accounting;
  deny(accounting?.evaluationId === prepared.evaluationId && accounting.basis === budget.requests.basis
    && accounting.basis === budget.cost.basis && accounting.currency === budget.cost.currency
    && Number.isSafeInteger(budget.requests.max) && Number.isSafeInteger(budget.cost.maxMicros)
    && Number.isSafeInteger(accounting.requestsUsed) && accounting.requestsUsed >= 0
    && accounting.requestsUsed < budget.requests.max
    && Number.isSafeInteger(accounting.costUsedMicros) && accounting.costUsedMicros >= 0
    && Number.isSafeInteger(accounting.estimatedCostMicros) && accounting.estimatedCostMicros !== null
    && accounting.estimatedCostMicros >= 0
    && accounting.estimatedCostMicros <= budget.cost.maxMicros - accounting.costUsedMicros,
  "Egress request or monetary budget is unavailable or exhausted.");
  return { endpoint: target, redirect: "error" };
}
