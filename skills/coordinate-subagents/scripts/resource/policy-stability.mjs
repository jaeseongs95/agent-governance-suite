/** Pure temporal policy projection; the caller owns and persists previous state. */
import { assert } from '../model-routing-core.mjs';

const STATES = ['NORMAL', 'CONSERVE', 'RESERVE', 'UNAVAILABLE', 'UNKNOWN'];
const SOFT = new Set(['NORMAL', 'CONSERVE']);
const timestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  && Number.isFinite(Date.parse(value));

export function stabilizeResourcePolicyV1({ candidateState, previousPolicyState, enteredAt,
  now, policyVersion, previousPolicyVersion, minimumHoldMs }) {
  assert(STATES.includes(candidateState) && timestamp(now)
    && Number.isSafeInteger(policyVersion) && policyVersion > 0
    && Number.isSafeInteger(minimumHoldMs) && minimumHoldMs >= 0,
  'INVALID_INPUT', 'State, policy version, explicit time, and minimum hold are required');
  assert(previousPolicyState === null && enteredAt === null && previousPolicyVersion === null
    || STATES.includes(previousPolicyState) && timestamp(enteredAt)
      && Number.isSafeInteger(previousPolicyVersion) && previousPolicyVersion > 0,
  'INVALID_INPUT', 'Previous state, entry time, and version must travel together');

  const versionChanged = previousPolicyVersion !== null && previousPolicyVersion !== policyVersion;
  let state = candidateState;
  let stateEnteredAt = now;
  let reason = previousPolicyState === null ? 'INITIAL_EVALUATION' : 'STATE_CHANGED';

  if (candidateState === 'UNAVAILABLE') {
    reason = 'HARD_UNAVAILABLE_IMMEDIATE';
  } else if (candidateState === 'RESERVE') {
    reason = 'HARD_RESERVE_IMMEDIATE';
  } else if (candidateState === 'UNKNOWN') {
    reason = 'UNKNOWN_IMMEDIATE';
  } else if (versionChanged) {
    reason = 'POLICY_VERSION_RESET';
  } else if (previousPolicyState !== null && Date.parse(now) < Date.parse(enteredAt)) {
    state = previousPolicyState;
    stateEnteredAt = enteredAt;
    reason = 'CLOCK_ROLLBACK_HOLD';
  } else if (previousPolicyState === candidateState) {
    stateEnteredAt = enteredAt;
    reason = 'STATE_UNCHANGED';
  } else if (SOFT.has(previousPolicyState) && SOFT.has(candidateState)) {
    const elapsed = Date.parse(now) - Date.parse(enteredAt);
    if (elapsed < minimumHoldMs) {
      state = previousPolicyState;
      stateEnteredAt = enteredAt;
      reason = 'MINIMUM_HOLD';
    }
  }
  if (previousPolicyState === candidateState && !versionChanged) stateEnteredAt = enteredAt;
  return {
    kind: 'policy-stability-output', state, enteredAt: stateEnteredAt,
    policyVersion, candidateState, reasonCode: reason,
    resetReason: versionChanged ? 'POLICY_VERSION_CHANGED' : null,
    previousStateInherited: state === previousPolicyState && !versionChanged,
  };
}
