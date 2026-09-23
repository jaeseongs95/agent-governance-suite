import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { FakeResourceCollectorV1 } from '../../../mcp-server/src/resource/collectors/fake.ts';
import { projectCollectorResponseV1 } from '../../../mcp-server/src/resource/collector-port.ts';
import { addMetricValuesV1 } from '../../../skills/coordinate-subagents/scripts/resource/metric-units.mjs';
import { evaluateResourcePolicyV1 } from '../../../skills/coordinate-subagents/scripts/resource/policy-evaluator.mjs';
import { combineResourcePreferenceV1 } from '../../../skills/coordinate-subagents/scripts/resource/preference-policy.mjs';
import { rankRoleResourceOptionsV1 } from '../../../skills/coordinate-subagents/scripts/resource/role-priority.mjs';
import { estimateWorkConsumptionV1 } from '../../../skills/coordinate-subagents/scripts/resource/work-estimate.mjs';
import { stabilizeResourcePolicyV1 } from '../../../skills/coordinate-subagents/scripts/resource/policy-stability.mjs';

const evidence = JSON.parse(readFileSync(new URL('../../../docs/implementation-3x/evidence/resource-policy.json', import.meta.url)));
const validator = new ContractValidator();

function snapshot(remaining, staleWindow = null) {
  const value = structuredClone(evidence.snapshot);
  value.windows.forEach((window, index) => {
    window.limitBucket.remaining = remaining[index];
    if (window.windowId === staleWindow) window.expiresAt = evidence.now;
  });
  return value;
}

test('R14 fixed multi-window policy cases replay exactly with explicit time, revision and shared pool', async () => {
  assert.equal(evidence.schemaVersion, '1.0.0');
  assert.equal(evidence.taskId, 'R14');
  const policy = validator.resourcePolicyV1(evidence.policy);
  assert.equal(new Set(policy.windows.map(item => item.windowId)).size, 2);
  for (const item of evidence.policyCases) {
    const observed = validator.resourceStateSnapshotV1(snapshot(item.remaining, item.staleWindow));
    assert.equal(observed.resourcePoolId, policy.resourcePoolId);
    const input = { snapshot: observed, policy, now: evidence.now };
    const first = evaluateResourcePolicyV1(input);
    const again = evaluateResourcePolicyV1(structuredClone(input));
    assert.deepEqual(again, first, item.id);
    assert.equal(first.state, item.expectedState, item.id);
    assert.equal(first.disposition, item.expectedDisposition, item.id);
    assert.deepEqual(first.outcomes.map(outcome => outcome.reason), item.expectedReasons, item.id);
    assert.deepEqual(first.outcomes.map(outcome => outcome.revision), [7, 4], item.id);
    assert.equal(first.policyRevision, 3);
    assert.equal(first.evaluatedAt, evidence.now);
  }
  const fresh = await import('../../../skills/coordinate-subagents/scripts/resource/policy-evaluator.mjs?r14-replay=1');
  const fixed = { snapshot: snapshot([29, 70]), policy: evidence.policy, now: evidence.now };
  assert.deepEqual(fresh.evaluateResourcePolicyV1(structuredClone(fixed)), evaluateResourcePolicyV1(fixed));
});

test('R14 preference and role advice preserve hard reserve and shared-pool identity', () => {
  for (const item of evidence.preferenceCases) {
    const result = combineResourcePreferenceV1({ snapshot: snapshot(item.remaining), policy: evidence.policy,
      now: evidence.now, strength: item.strength, roleId: item.roleId });
    assert.equal(result.admission, item.expectedAdmission, item.id);
    assert.equal(result.preferenceRank, item.expectedRank, item.id);
    assert.equal(result.executionAuthorized, false);
  }
  const role = evidence.roleCase;
  const options = [
    { optionId: 'bulk', roleId: 'bulk', workClass: 'work', strength: 'required', utilityScore: 999 },
    { optionId: 'audit', roleId: 'audit', workClass: 'judgment', strength: 'required', utilityScore: 0 },
  ].map(option => ({ ...option, snapshot: snapshot(role.remaining), policy: structuredClone(evidence.policy),
    estimates: structuredClone(role.estimateByWindow) }));
  assert.equal(options[0].snapshot.resourcePoolId, options[1].snapshot.resourcePoolId);
  const first = rankRoleResourceOptionsV1({ options, now: evidence.now });
  assert.deepEqual(rankRoleResourceOptionsV1({ options: structuredClone(options), now: evidence.now }), first);
  assert.deepEqual(first.ranked.map(item => item.optionId), role.expectedRanked);
  assert.deepEqual(first.rejected, role.expectedRejected);
  assert.deepEqual(first.ranked[0].planned.map(item => item.projectedRemaining), role.expectedProjectedRemaining);
  assert.equal(first.executionAuthorized, false);
  assert.equal(first.reservationIssued, false);
  const priority = evidence.rolePriorityCase;
  const eligible = options.map(option => ({ ...option, workClass: 'work', snapshot: snapshot(priority.remaining) }));
  const priorityResult = rankRoleResourceOptionsV1({ options: eligible, now: evidence.now });
  assert.deepEqual(priorityResult.ranked.map(item => item.optionId), priority.expectedRanked);
  assert.deepEqual(priorityResult.rejected, priority.expectedRejected);
});

test('R14 valid request/token windows retain separate units, while unknown and mismatches cannot become capacity', () => {
  const mixedCase = evidence.mixedUnitCase;
  const validMixed = snapshot(mixedCase.remaining);
  validMixed.windows[1].limitBucket.kind = mixedCase.weeklyBucketKind;
  validMixed.windows[1].limitBucket.unit = mixedCase.weeklyUnit;
  const mixedPolicy = structuredClone(evidence.policy);
  mixedPolicy.windows[1].unit = mixedCase.weeklyUnit;
  validator.resourceStateSnapshotV1(validMixed);
  validator.resourcePolicyV1(mixedPolicy);
  assert.equal(evaluateResourcePolicyV1({ snapshot: validMixed, policy: mixedPolicy, now: evidence.now }).state,
    mixedCase.expectedState);
  const validOption = { optionId: 'mixed-valid', roleId: 'bulk', workClass: 'work', strength: 'required',
    utilityScore: 0, snapshot: validMixed, policy: mixedPolicy, estimates: mixedCase.estimates };
  const mixedResult = rankRoleResourceOptionsV1({ options: [validOption], now: evidence.now });
  assert.deepEqual(mixedResult.ranked[0].planned, mixedCase.expectedPlanned);
  assert.equal(mixedResult.reservationIssued, false);
  const wrongEstimate = structuredClone(validOption);
  wrongEstimate.estimates[1].unit = 'request';
  assert.throws(() => rankRoleResourceOptionsV1({ options: [wrongEstimate], now: evidence.now }),
    { code: 'INVALID_INPUT' });

  const unknown = snapshot([null, 70]);
  assert.equal(evaluateResourcePolicyV1({ snapshot: unknown, policy: evidence.policy, now: evidence.now }).state, 'UNKNOWN');
  const mixed = snapshot([70, 70]);
  mixed.windows[0].limitBucket.unit = 'token';
  assert.throws(() => validator.resourceStateSnapshotV1(mixed), { code: 'INVALID_INPUT' });
  assert.throws(() => evaluateResourcePolicyV1({ snapshot: mixed, policy: evidence.policy, now: evidence.now }),
    { code: 'INVALID_INPUT' });
  assert.throws(() => addMetricValuesV1({ kind: 'token', amount: 1 }, { kind: 'request', amount: 1 }),
    { code: 'UNIT_MISMATCH' });
  const invalidRole = { optionId: 'mixed', roleId: 'bulk', workClass: 'work', strength: 'required',
    utilityScore: 0, snapshot: snapshot([70, 70]), policy: evidence.policy,
    estimates: structuredClone(evidence.roleCase.estimateByWindow) };
  invalidRole.estimates[0].unit = 'token';
  assert.throws(() => rankRoleResourceOptionsV1({ options: [invalidRole], now: evidence.now }),
    { code: 'INVALID_INPUT' });
});

test('R14 replays estimate, authorization, uninstalled cap, previous state and entry time', () => {
  const plan = estimateWorkConsumptionV1(structuredClone(evidence.workEstimate.input));
  for (const [key, expected] of Object.entries(evidence.workEstimate.expected)) assert.equal(plan[key], expected, key);
  assert.deepEqual(estimateWorkConsumptionV1(structuredClone(evidence.workEstimate.input)), plan);
  assert.equal(plan.runtimeCapSupportClaim, true);
  assert.equal(plan.runtimeCapSupported, false);
  const held = stabilizeResourcePolicyV1(structuredClone(evidence.stability.input));
  for (const [key, expected] of Object.entries(evidence.stability.expected)) assert.equal(held[key], expected, key);
  assert.deepEqual(stabilizeResourcePolicyV1(structuredClone(evidence.stability.input)), held);
  assert.equal(stabilizeResourcePolicyV1({ ...evidence.stability.input, now: '2026-09-23T12:01:00Z' }).state, 'NORMAL');
});

test('R14 fake collector replay retains unadmitted source and unavailable base', async () => {
  const sourceSnapshot = snapshot([70, 70]);
  sourceSnapshot.windows.forEach(window => { window.source = { kind: 'user-declared', evidenceDigest: null }; });
  const scope = { collectorId: 'r14-fixture', source: 'fake', accountScope: sourceSnapshot.accountScope,
    resourcePoolId: sourceSnapshot.resourcePoolId };
  const full = { schemaVersion: '1.0.0', kind: 'full', ...scope, sequence: 1, snapshot: sourceSnapshot };
  const unavailable = { schemaVersion: '1.0.0', kind: 'unavailable', ...scope, sequence: 2, reason: 'not-exposed' };
  const collector = new FakeResourceCollectorV1(scope, [full, unavailable]);
  const first = projectCollectorResponseV1(scope, null, await collector.collect()).state;
  assert.equal(first.observationAdmitted, false);
  assert.equal(first.snapshot.windows[0].source.kind, 'user-declared');
  const lost = projectCollectorResponseV1(scope, first, await collector.collect()).state;
  assert.equal(lost.availability, 'unavailable');
  assert.equal(lost.snapshot, null);
  assert.equal(lost.knownWindows.length, 2);
});

test('R14 preserves the frozen S1c/v2 golden bytes', () => {
  const raw = readFileSync(new URL('../semantic-decision/fixtures/v2-golden.json', import.meta.url));
  assert.equal(createHash('sha256').update(raw).digest('hex'), evidence.v2GoldenSha256);
});
