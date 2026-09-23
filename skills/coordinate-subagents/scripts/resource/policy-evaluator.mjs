/** Pure policy projection. The caller must authenticate policy approval and admit observations. */
import { assert } from '../model-routing-core.mjs';

const RANK = { NORMAL: 0, CONSERVE: 1, RESERVE: 2, UNKNOWN: 3, UNAVAILABLE: 4 };

export function evaluateResourcePolicyV1({ snapshot, policy, now }) {
  const nowMs = typeof now === 'string' ? Date.parse(now) : NaN;
  assert(Number.isFinite(nowMs), 'INVALID_INPUT', 'Explicit evaluation time is required');
  assert(snapshot?.schemaVersion === '1.0.0' && policy?.schemaVersion === '1.0.0'
    && snapshot.accountScope === policy.accountScope
    && snapshot.resourcePoolId === policy.resourcePoolId,
  'INVALID_INPUT', 'Policy and snapshot must bind to the same account and pool');
  assert(/^sha256:[a-f0-9]{64}$/u.test(policy.approval?.evidenceDigest ?? '')
    && Array.isArray(policy.allowedAccessPaths), 'INVALID_INPUT', 'Approved policy claim and access paths are required');
  assert(Array.isArray(snapshot.windows) && Array.isArray(policy.windows), 'INVALID_INPUT', 'Resource windows are required');
  const byWindow = new Map(policy.windows.map((window) => [window.windowId, window]));
  assert(byWindow.size === policy.windows.length && snapshot.windows.length === policy.windows.length
    && new Set(snapshot.windows.map((window) => window.windowId)).size === snapshot.windows.length,
    'INVALID_INPUT', 'Policy must cover every resource window exactly once');

  const outcomes = [];
  for (const window of snapshot.windows) {
    const rule = byWindow.get(window.windowId);
    assert(rule && rule.bucketId === window.limitBucket?.bucketId && rule.unit === window.limitBucket.unit,
      'INVALID_INPUT', 'Policy window must match its observed bucket and unit');
    const remaining = window.limitBucket.remaining;
    let state = 'NORMAL';
    let reason = 'ABOVE_POLICY_FLOORS';
    const unknown = window.coverage !== 'complete' || remaining === null
      || !Number.isFinite(remaining) || remaining < 0;
    const stale = !Number.isFinite(Date.parse(window.observedAt))
      || !Number.isFinite(Date.parse(window.expiresAt))
      || nowMs < Date.parse(window.observedAt) || nowMs >= Date.parse(window.expiresAt);
    if (unknown || stale) {
      state = 'UNKNOWN';
      reason = unknown && stale ? 'UNKNOWN_STALE_WINDOW' : unknown ? 'UNKNOWN_WINDOW' : 'STALE_WINDOW';
    } else if (remaining === 0 || rule.hardLimit && remaining <= rule.hardLimit.minimumRemaining) {
      state = 'UNAVAILABLE'; reason = remaining === 0 ? 'EXHAUSTED_WINDOW' : 'HARD_LIMIT';
    } else if (rule.reservePolicy?.hardReserve
      && remaining <= rule.reservePolicy.hardReserve.minimumRemaining) {
      state = 'RESERVE'; reason = 'HARD_RESERVE';
    } else if (rule.reservePolicy?.softConservation
      && remaining < rule.reservePolicy.softConservation.enterBelowRemaining) {
      state = 'CONSERVE'; reason = 'SOFT_CONSERVATION';
    }
    outcomes.push({ windowId: window.windowId, state, reason, revision: window.revision });
  }
  if (!policy.allowedAccessPaths.includes(snapshot.accessPath)
    || snapshot.accessPath !== 'subscription' && !/^sha256:[a-f0-9]{64}$/u.test(policy.paidAccessApproval?.evidenceDigest ?? '')) {
    outcomes.push({ windowId: null, state: 'UNAVAILABLE', reason: 'ACCESS_PATH_DENIED', revision: null });
  }
  outcomes.sort((a, b) => (a.windowId ?? '') < (b.windowId ?? '') ? -1 : (a.windowId ?? '') > (b.windowId ?? '') ? 1 : 0);
  const state = outcomes.reduce((worst, item) => RANK[item.state] > RANK[worst] ? item.state : worst, 'NORMAL');
  const unknownDisposition = outcomes.some((item) => (item.reason === 'UNKNOWN_WINDOW' || item.reason === 'UNKNOWN_STALE_WINDOW') && policy.onUnknown === 'block'
    || (item.reason === 'STALE_WINDOW' || item.reason === 'UNKNOWN_STALE_WINDOW') && policy.onStale === 'block') ? 'block' : 'defer';
  return {
    kind: 'policy-output', state, evaluatedAt: now, policyId: policy.policyId,
    policyRevision: policy.revision, resourcePoolId: policy.resourcePoolId,
    disposition: state === 'UNKNOWN' ? unknownDisposition
      : state === 'UNAVAILABLE' ? 'block' : 'none',
    outcomes,
  };
}
