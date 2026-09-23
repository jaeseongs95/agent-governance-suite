/** Deterministic allocation advice; the caller must authenticate slots, policy and observations. */
import { assert } from '../model-routing-core.mjs';
import { evaluateResourcePolicyV1 } from './policy-evaluator.mjs';
import { combineResourcePreferenceV1 } from './preference-policy.mjs';

const PHASES = ['work', 'judgment', 'review', 'handoff'];
const CLASS_RANK = { judgment: 0, review: 1, handoff: 2, work: 3 };
const COUNT_UNITS = new Set(['token', 'request', 'slot']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}$/u.test(value);
const quantity = (amount, unit) => amount === null || typeof amount === 'number'
  && Number.isFinite(amount) && amount >= 0
  && (!COUNT_UNITS.has(unit) || Number.isSafeInteger(amount));

export function rankRoleResourceOptionsV1({ options, now }) {
  assert(Array.isArray(options) && options.length > 0 && options.length <= 64
    && typeof now === 'string' && Number.isFinite(Date.parse(now)),
  'INVALID_INPUT', 'Bounded options and explicit time are required');
  const seen = new Set();
  const ranked = [], rejected = [];
  for (const option of options) {
    assert(id(option?.optionId) && !seen.has(option.optionId)
      && id(option.roleId) && Object.hasOwn(CLASS_RANK, option.workClass)
      && ['required', 'preferred'].includes(option.strength)
      && typeof option.utilityScore === 'number' && Number.isFinite(option.utilityScore)
      && option.utilityScore >= 0
      && Array.isArray(option.snapshot?.windows) && option.snapshot.windows.length > 0
      && option.snapshot.windows.length <= 64
      && Array.isArray(option.policy?.windows)
      && option.policy.windows.length === option.snapshot.windows.length,
    'INVALID_INPUT', 'Option identity, role, score and nonempty resource windows are required');
    seen.add(option.optionId);
    const resource = evaluateResourcePolicyV1({ snapshot: option.snapshot, policy: option.policy, now });
    const preference = combineResourcePreferenceV1({ snapshot: option.snapshot, policy: option.policy,
      now, strength: option.strength, roleId: option.roleId });
    assert(Array.isArray(option.estimates) && option.estimates.length === option.snapshot.windows.length
      && new Set(option.estimates.map((item) => item.windowId)).size === option.estimates.length,
    'INVALID_INPUT', 'One estimate per resource window is required');
    if (preference.admission !== 'allow') {
      rejected.push({ optionId: option.optionId, disposition: preference.admission,
        reason: preference.reasonCodes.at(-1) });
      continue;
    }
    const byEstimate = new Map(option.estimates.map((item) => [item.windowId, item]));
    let reason = null;
    let pressureRank = 0;
    const planned = [];
    for (const window of option.snapshot.windows) {
      const rule = option.policy.windows.find((item) => item.windowId === window.windowId);
      const estimate = byEstimate.get(window.windowId);
      assert(rule && estimate && estimate.unit === window.limitBucket.unit
        && estimate.phases && Object.keys(estimate.phases).length === PHASES.length
        && PHASES.every((phase) => Object.hasOwn(estimate.phases, phase)
          && quantity(estimate.phases[phase], estimate.unit)),
      'INVALID_INPUT', 'All four phase estimates must match their resource window and unit');
      if (!COUNT_UNITS.has(estimate.unit)) { reason = 'UNSUPPORTED_ESTIMATE_UNIT'; break; }
      const amounts = PHASES.map((phase) => estimate.phases[phase]);
      if (amounts.includes(null)) { reason = 'UNKNOWN_ESTIMATE'; break; }
      const required = estimate.unit === 'slot' ? Math.max(...amounts)
        : amounts.reduce((sum, amount) => sum + amount, 0);
      assert(Number.isFinite(required) && (!COUNT_UNITS.has(estimate.unit) || Number.isSafeInteger(required)),
        'INVALID_INPUT', 'Planned amount exceeds its unit range');
      const remaining = window.limitBucket.remaining;
      if (remaining === null) { reason = 'UNKNOWN_REMAINING'; break; }
      assert(rule.hardLimit !== undefined || rule.reservePolicy !== undefined,
        'INVALID_INPUT', 'Every window needs an explicit policy floor');
      assert(rule.hardLimit === undefined || rule.hardLimit.minimumRemaining !== undefined,
        'INVALID_INPUT', 'Hard limit floor is required');
      assert(rule.reservePolicy === undefined || rule.reservePolicy.hardReserve !== undefined
        || rule.reservePolicy.softConservation !== undefined,
      'INVALID_INPUT', 'Reserve policy needs a floor');
      assert(rule.reservePolicy?.softConservation === undefined
        || rule.reservePolicy.softConservation.enterBelowRemaining !== undefined,
      'INVALID_INPUT', 'Soft conservation floor is required');
      const hardFloor = rule.hardLimit?.minimumRemaining ?? 0;
      const reserve = rule.reservePolicy?.hardReserve;
      const softFloor = rule.reservePolicy?.softConservation?.enterBelowRemaining;
      assert(reserve === undefined || Array.isArray(reserve.protectedRoleIds)
        && reserve.protectedRoleIds.length > 0
        && new Set(reserve.protectedRoleIds).size === reserve.protectedRoleIds.length
        && reserve.protectedRoleIds.every(id),
      'INVALID_INPUT', 'Protected roles must be an exact role ID set');
      assert(Number.isSafeInteger(remaining) && remaining >= 0
        && Number.isSafeInteger(hardFloor) && hardFloor >= 0
        && (reserve === undefined || Number.isSafeInteger(reserve.minimumRemaining)
          && reserve.minimumRemaining >= hardFloor)
        && (softFloor === undefined || Number.isSafeInteger(softFloor)
          && softFloor >= (reserve?.minimumRemaining ?? hardFloor)),
      'INVALID_INPUT', 'Count-unit remaining and policy floors must be consistent');
      const override = option.strength === 'preferred'
        && option.policy.preferenceOverride?.mode === 'preferred-through-hard-reserve'
        && /^sha256:[a-f0-9]{64}$/u.test(option.policy.preferenceOverride.approval?.evidenceDigest ?? '');
      const protectedRole = reserve?.protectedRoleIds.includes(option.roleId) || override;
      const floor = protectedRole ? hardFloor : Math.max(hardFloor, reserve?.minimumRemaining ?? hardFloor);
      const after = remaining - required;
      if (after < floor) { reason = after < hardFloor ? 'HARD_LIMIT' : 'HARD_RESERVE'; break; }
      if (reserve && after < reserve.minimumRemaining) pressureRank = Math.max(pressureRank, 2);
      else if (softFloor !== undefined && after < softFloor) {
        pressureRank = Math.max(pressureRank, 1);
      }
      planned.push({ windowId: window.windowId, unit: estimate.unit, required, projectedRemaining: after });
    }
    if (reason) {
      rejected.push({ optionId: option.optionId, disposition: 'defer', reason });
      continue;
    }
    const rolePriority = option.policy.rolePriorities?.find((role) => role.roleId === option.roleId)?.priority ?? 0;
    assert(Number.isSafeInteger(rolePriority) && rolePriority >= 0, 'INVALID_INPUT', 'Invalid role priority');
    ranked.push({ optionId: option.optionId, roleId: option.roleId, workClass: option.workClass,
      preferenceRank: preference.preferenceRank, rolePriority, pressureRank,
      utilityScore: option.utilityScore, policyId: resource.policyId, policyRevision: resource.policyRevision,
      planned: planned.sort((a, b) => a.windowId.localeCompare(b.windowId)) });
  }
  ranked.sort((a, b) => a.preferenceRank - b.preferenceRank || a.rolePriority - b.rolePriority
    || CLASS_RANK[a.workClass] - CLASS_RANK[b.workClass] || a.pressureRank - b.pressureRank
    || b.utilityScore - a.utilityScore || (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0));
  rejected.sort((a, b) => a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0);
  return { kind: 'role-priority-output', ranked, rejected,
    executionAuthorized: false, reservationIssued: false };
}
