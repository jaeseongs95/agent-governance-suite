/** Pure admission advice; policy approval and observations require caller authentication. */
import { assert } from '../model-routing-core.mjs';
import { evaluateResourcePolicyV1 } from './policy-evaluator.mjs';

export function combineResourcePreferenceV1({ snapshot, policy, now, strength, roleId }) {
  assert(['required', 'preferred'].includes(strength) && typeof roleId === 'string' && roleId.length > 0,
    'INVALID_INPUT', 'Preference strength and role are required');
  const resource = evaluateResourcePolicyV1({ snapshot, policy, now });
  const override = policy.preferenceOverride;
  const explicitOverride = /^sha256:[a-f0-9]{64}$/u.test(override?.approval?.evidenceDigest ?? '');
  const preferredFirst = explicitOverride && override.mode === 'preferred-over-required';
  const preferenceRank = strength === 'required' ? (preferredFirst ? 1 : 0) : (preferredFirst ? 0 : 1);
  let admission = 'allow';
  let reason = strength === 'required' ? 'REQUIRED_ALLOWED' : 'PREFERRED_ALLOWED';

  if (resource.state === 'UNAVAILABLE') {
    admission = 'block'; reason = strength === 'required' ? 'REQUIRED_UNAVAILABLE' : 'PREFERRED_UNAVAILABLE';
  } else if (resource.state === 'UNKNOWN') {
    admission = resource.disposition; reason = 'RESOURCE_UNKNOWN';
  } else if (resource.state === 'RESERVE') {
    const reserved = resource.outcomes.filter((outcome) => outcome.state === 'RESERVE');
    const protectedRole = reserved.every((outcome) => policy.windows.find((window) => window.windowId === outcome.windowId)
      ?.reservePolicy?.hardReserve?.protectedRoleIds.includes(roleId));
    if (protectedRole) reason = 'PROTECTED_ROLE_RESERVE';
    else if (strength === 'preferred' && explicitOverride && override.mode === 'preferred-through-hard-reserve') {
      reason = 'APPROVED_RESERVE_EXCEPTION';
    } else {
      admission = 'block'; reason = 'HARD_RESERVE';
    }
  } else if (resource.state === 'CONSERVE' && strength === 'preferred') {
    reason = 'PREFERRED_BEATS_SOFT_CONSERVE';
  }

  return {
    kind: 'preference-policy-output', executionAuthorized: false, admission, strength, roleId, preferenceRank,
    resourceState: resource.state, policyId: resource.policyId, policyRevision: resource.policyRevision,
    reasonCodes: [...new Set([...resource.outcomes.filter((outcome) => outcome.reason !== 'ABOVE_POLICY_FLOORS')
      .map((outcome) => outcome.reason), reason, ...(preferredFirst ? ['PREFERENCE_PRIORITY_OVERRIDE'] : [])])],
  };
}
