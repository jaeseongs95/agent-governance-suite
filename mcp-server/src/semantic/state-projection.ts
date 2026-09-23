import type { ModelCatalogV1, ModelSelectionRequestV2, SemanticDecisionQuestionV1, SemanticDecisionStateV1 } from "../../../contracts/types.js";
import { digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";

export const SEMANTIC_STATE_PROJECTION_VERSION = "1.0.0";

/** Selects only catalog evidence relevant to the eligible models; never reads current host state. */
export function projectSemanticState(input: {
  routingRequest: Readonly<ModelSelectionRequestV2>;
  catalog: Readonly<ModelCatalogV1>;
  eligibleModelIds: readonly string[];
  question: Readonly<SemanticDecisionQuestionV1>;
  projectionVersion?: string;
}): {
  projectionVersion: string;
  state: SemanticDecisionStateV1;
  stateDigest: string;
  question: SemanticDecisionQuestionV1;
  questionDigest: string;
} {
  const { routingRequest, catalog, eligibleModelIds } = input;
  const projectionVersion = input.projectionVersion ?? SEMANTIC_STATE_PROJECTION_VERSION;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u.test(projectionVersion)
    || eligibleModelIds.length === 0 || new Set(eligibleModelIds).size !== eligibleModelIds.length) {
    throw new TypeError("Invalid semantic state projection input.");
  }

  const models = eligibleModelIds.map(id => {
    const model = catalog.models.find(entry => entry.id === id);
    if (!model) throw new TypeError(`Unknown eligible model: ${id}`);
    const sources = model.sourceIds.map(sourceId => {
      const source = catalog.sources.find(entry => entry.id === sourceId);
      if (!source) throw new TypeError(`Missing catalog source: ${sourceId}`);
      return { id: source.id, url: source.url, evidenceKind: source.evidenceKind, checkedAt: source.checkedAt, note: source.note };
    });
    return {
      id: model.id,
      officialPositioning: model.officialPositioning,
      policyClass: model.modelClass,
      policyStatus: model.status,
      recommendationBasis: model.recommendationBasis,
      roleFit: model.roles.includes(routingRequest.role),
      listedRoles: model.roles,
      matchingTaskTraits: (routingRequest.taskTraits ?? []).filter(trait => model.taskTraits.includes(trait)),
      missingTaskTraits: (routingRequest.taskTraits ?? []).filter(trait => !model.taskTraits.includes(trait)),
      missingInputModalities: routingRequest.requirements.inputModalities.filter(modality => !model.inputModalities.includes(modality)),
      documentedInputModalities: model.inputModalities,
      documentedReasoningKinds: model.nativeKinds,
      contextTokens: model.contextTokens,
      catalogVerification: model.verification,
      hostCapability: "requires-current-capability-snapshot",
      measuredAbilityScore: model.abilityScore,
      catalogCheckedAt: model.checkedAt,
      sources,
    };
  });
  const text = JSON.stringify({
    projectionVersion,
    task: {
      role: routingRequest.role,
      highRisk: routingRequest.highRisk,
      taskTraits: routingRequest.taskTraits ?? [],
      requirements: {
        inputModalities: routingRequest.requirements.inputModalities,
        tools: routingRequest.requirements.tools,
        filesystem: routingRequest.requirements.filesystem,
        allowedSurfaces: routingRequest.requirements.allowedSurfaces,
        allowedRuntimeModes: routingRequest.requirements.allowedRuntimeModes,
        allowNestedDelegation: routingRequest.requirements.allowNestedDelegation,
        requireObservable: routingRequest.requirements.requireObservable,
        contextMode: routingRequest.requirements.contextMode,
      },
    },
    catalogSnapshotDate: catalog.snapshotDate,
    models,
  });
  if (text.length > 32768) throw new RangeError("Semantic state projection exceeds the request contract.");
  const state: SemanticDecisionStateV1 = {
    text,
    sources: [
      { kind: "task", id: routingRequest.binding.taskId, digest: routingRequest.binding.inputDigest },
      { kind: "artifact", id: "model-catalog", digest: catalog.catalogDigest },
    ],
    summaryDigest: null,
  };
  const question = structuredClone(input.question);
  return { projectionVersion, state, stateDigest: digest(state), question, questionDigest: digest(question) };
}
