import type {
  SemanticDecisionPolicyV1, SemanticDecisionProviderV1, SemanticDecisionQuestionV1,
  SemanticDecisionRequestV1,
} from "../../../contracts/types.js";
import {
  collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, seal,
  type RoutingEnvironmentV2,
} from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { projectSemanticCandidatesV1 } from "../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs";
import { assertPreparedSemanticInputV1 } from "../../../skills/coordinate-subagents/scripts/semantic/prepared-input-check.mjs";
import { SEMANTIC_REDUCER_VERSION_V1 } from "../../../skills/coordinate-subagents/scripts/semantic/replay.mjs";
import { ContractValidator } from "../schema-validator.js";
import type { WorkflowStore } from "../workflow-store.js";
import { projectSemanticState } from "./state-projection.js";
import { resolveTaskReference, type TaskReferencePrincipal } from "./task-ref-resolver.js";

/** Internal only: caller/session principal and every input except assignment come from the owning server. */
export function prepareSemanticRequest(input: {
  assignment: unknown;
  store: Pick<WorkflowStore, "getGuardedRunSnapshot">;
  principal: Readonly<TaskReferencePrincipal>;
  environment: RoutingEnvironmentV2;
  semanticPolicy: SemanticDecisionPolicyV1;
  question: SemanticDecisionQuestionV1;
  provider: Omit<SemanticDecisionProviderV1, "providerVersion" | "modelVersion"> &
    Partial<Pick<SemanticDecisionProviderV1, "providerVersion" | "modelVersion">>;
  evaluationId: string;
  expiresAt: string;
}): SemanticDecisionRequestV1 {
  const validator = new ContractValidator();
  const assignment = validator.semanticModelAssignmentRequestV1(input.assignment);
  const resolved = resolveTaskReference(assignment, input.store, input.principal);
  const policy = validator.semanticDecisionPolicyV1(input.semanticPolicy);
  if (policy.mode === "off") throw new TypeError("Semantic evaluation is disabled.");
  const routingRequest = assignment.routingRequest;
  const pool = collectEligibleCandidatesV2(routingRequest, input.environment);
  const metadata = getBaselineCandidateMetadataV2(pool.candidates, routingRequest, input.environment);
  const mapping = projectSemanticCandidatesV1(pool.candidates, metadata);
  if (!mapping) throw new TypeError("No eligible candidates for semantic evaluation.");
  const projected = projectSemanticState({
    routingRequest, catalog: input.environment.catalog,
    eligibleModelIds: mapping.options.map(option => option.model), question: input.question,
  });
  const state = {
    ...projected.state,
    sources: [...resolved.sources, ...projected.state.sources.filter(source => source.kind !== "task")],
  };
  const request = seal({
    schemaVersion: "1.0.0" as const,
    evaluationId: input.evaluationId,
    binding: structuredClone(routingRequest.binding),
    effectiveRoutingRequestDigest: digest(routingRequest),
    stateDigest: digest(state), questionDigest: projected.questionDigest,
    catalogDigest: input.environment.catalog.catalogDigest,
    routingPolicyDigest: digest(input.environment.policy),
    semanticPolicyDigest: digest(policy),
    capabilitySetDigest: pool.capabilitySetDigest,
    eligibleSetDigest: digest(mapping.eligibleSet),
    optionMappingDigest: digest(mapping.options),
    provider: {
      id: input.provider.id, model: input.provider.model,
      adapterVersion: input.provider.adapterVersion,
      providerVersion: input.provider.providerVersion ?? null,
      modelVersion: input.provider.modelVersion ?? null,
    },
    reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
    mode: policy.mode,
    state, question: projected.question,
    eligibleSet: mapping.eligibleSet, options: mapping.options,
    requestedAt: input.environment.now, expiresAt: input.expiresAt,
  }, "requestDigest");
  const prepared = validator.semanticDecisionRequestV1(request);
  assertPreparedSemanticInputV1(prepared, routingRequest, input.environment, input.environment.now);
  return prepared;
}
