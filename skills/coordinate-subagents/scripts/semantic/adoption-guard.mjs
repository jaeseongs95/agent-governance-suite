/** Pure adoption assessment. Only the owning service may supply admitted evidence. */
import { canonical, digest } from '../model-routing-core.mjs';

export function assessSemanticAdoptionV1(policy, routingRequest, prepared, advice, evidenceAdmission = null) {
  const baseline = reasonCode => ({ status: 'baseline', reasonCode });
  if (policy.mode === 'off') return baseline('POLICY_OFF');
  if (policy.mode === 'shadow') return baseline('SHADOW_ONLY');
  if (policy.mode !== 'assist' || prepared.mode !== 'assist') return baseline('MODE_MISMATCH');
  if (routingRequest.highRisk) return baseline('HIGH_RISK_EXCLUDED');
  if (routingRequest.role === 'independent-audit') return baseline('INDEPENDENT_AUDIT_EXCLUDED');
  const scope = policy.assistScope;
  if (scope?.highRisk !== false || scope.independentAudit !== false
    || scope.selectionUnit !== 'model' || scope.tieBreak !== 'baseline-order'
    || (routingRequest.user?.strength === 'required' && scope.preserveRequired !== true)
    || (routingRequest.user?.strength === 'preferred' && scope.preservePreferred !== true)) return baseline('SCOPE_NOT_PRESERVED');
  const adoption = policy.adoption;
  if (adoption?.status !== 'validated' || !/^sha256:[a-f0-9]{64}$/u.test(adoption.evidenceDigest)
    || typeof adoption.minimumConfidence !== 'number' || !Number.isFinite(adoption.minimumConfidence)
    || adoption.minimumConfidence < 0 || adoption.minimumConfidence > 1) return baseline('ADOPTION_UNVALIDATED');
  if (!policy.egress?.enabled || !policy.egress.allowedProviders?.includes(prepared.provider?.id)) return baseline('PROVIDER_NOT_ALLOWED');
  if (canonical(adoption.provider) !== canonical(prepared.provider)
    || canonical(prepared.provider) !== canonical(advice.provider)) return baseline('PROVIDER_MISMATCH');
  if (adoption.questionDigest !== prepared.questionDigest || prepared.questionDigest !== advice.questionDigest) return baseline('QUESTION_MISMATCH');
  if (adoption.reducerVersion !== prepared.reducerVersion || prepared.reducerVersion !== advice.reducerVersion) return baseline('REDUCER_MISMATCH');
  if (prepared.semanticPolicyDigest !== digest(policy) || advice.semanticPolicyDigest !== prepared.semanticPolicyDigest
    || advice.semanticRequestDigest !== prepared.requestDigest) return baseline('REQUEST_BINDING_MISMATCH');
  if (evidenceAdmission?.status !== 'admitted' || evidenceAdmission.evidenceDigest !== adoption.evidenceDigest) return baseline('EVIDENCE_NOT_ADMITTED');
  const confidence = advice.choice?.confidence;
  if (confidence === null) return baseline('CONFIDENCE_UNKNOWN');
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return baseline('CONFIDENCE_INVALID');
  if (confidence < adoption.minimumConfidence) return baseline('CONFIDENCE_BELOW_MINIMUM');
  return { status: 'eligible', evidenceDigest: adoption.evidenceDigest };
}
