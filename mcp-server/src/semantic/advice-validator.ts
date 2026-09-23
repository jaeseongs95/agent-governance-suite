/** Internal normalization only. A valid advice artifact is not an admission receipt. */
import { WorkflowContractError, type SemanticDecisionAdviceV1 } from "../../../contracts/types.js";
import { instant, seal } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ContractValidator } from "../schema-validator.js";
import { parseSemanticProviderResultV1 } from "./provider-port.js";

const validator = new ContractValidator();

/** Validate an existing advice artifact against the exact prepared request at observation time. */
export function validateSemanticAdviceForRequest(input: {
  prepared: unknown;
  advice: unknown;
  now: string;
}): SemanticDecisionAdviceV1 {
  const advice = validator.semanticDecisionAdviceForRequestV1(input.advice, input.prepared);
  let now: number;
  try {
    now = instant(input.now, "semantic advice observation time");
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", "Canonical UTC semantic advice observation time required.");
  }
  if (instant(advice.evaluatedAt, "advice evaluatedAt") > now || now >= instant(advice.expiresAt, "advice expiresAt")) {
    throw new WorkflowContractError("INVALID_INPUT", "Semantic advice is future-dated or expired.");
  }
  return advice;
}

/** Only the prepared request supplies binding and provider versions; raw provider output supplies a Choice. */
export function normalizeSemanticProviderResult(input: {
  prepared: unknown;
  rawResult: unknown;
  now: string;
}): SemanticDecisionAdviceV1 {
  const request = validator.semanticDecisionRequestV1(input.prepared);
  const result = parseSemanticProviderResultV1(input.rawResult);
  if (result.status !== "success") {
    throw new WorkflowContractError("INVALID_INPUT", "Provider result contains no semantic Choice.");
  }
  const advice = seal({
    schemaVersion: request.schemaVersion,
    evaluationId: request.evaluationId, binding: structuredClone(request.binding),
    effectiveRoutingRequestDigest: request.effectiveRoutingRequestDigest,
    stateDigest: request.stateDigest, questionDigest: request.questionDigest,
    catalogDigest: request.catalogDigest, routingPolicyDigest: request.routingPolicyDigest,
    semanticPolicyDigest: request.semanticPolicyDigest, capabilitySetDigest: request.capabilitySetDigest,
    eligibleSetDigest: request.eligibleSetDigest, optionMappingDigest: request.optionMappingDigest,
    provider: structuredClone(request.provider), reducerVersion: request.reducerVersion,
    semanticRequestDigest: request.requestDigest,
    choice: structuredClone(result.choice), evaluatedAt: input.now,
    expiresAt: request.expiresAt,
  }, "adviceDigest");
  return validateSemanticAdviceForRequest({ prepared: request, advice, now: input.now });
}
