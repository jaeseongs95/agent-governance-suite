import type {
  ModelSelectionRequestV2, SemanticDecisionAdviceV1, SemanticDecisionPolicyV1, SemanticDecisionRequestV1,
} from '../../../../contracts/types.js';

/** Supplied only by the owning service after admission; this helper never creates it. */
export type ServiceAdmittedSemanticEvidenceV1 = { readonly status: 'admitted'; readonly evidenceDigest: string };
export type SemanticAdoptionAssessmentV1 =
  | { status: 'baseline'; reasonCode: string }
  | { status: 'eligible'; evidenceDigest: string };
/** Eligibility is not a dispatch permission or evidence-admission receipt. */
export declare function assessSemanticAdoptionV1(
  policy: SemanticDecisionPolicyV1,
  routingRequest: ModelSelectionRequestV2,
  prepared: SemanticDecisionRequestV1,
  advice: SemanticDecisionAdviceV1,
  evidenceAdmission?: ServiceAdmittedSemanticEvidenceV1 | null,
): SemanticAdoptionAssessmentV1;
