import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';

const validator = new ContractValidator();
const approval = () => ({ approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00Z', evidenceDigest: `sha256:${'a'.repeat(64)}` });
const policy = () => ({
  schemaVersion: '1.0.0', policyId: 'pool-policy', revision: 1,
  accountScope: `acct-hmac-sha256:${'b'.repeat(64)}`, resourcePoolId: 'shared-pool',
  approval: approval(), allowedAccessPaths: ['subscription'], onUnknown: 'defer', onStale: 'block',
  rolePriorities: [{ roleId: 'independent-audit', priority: 0 }, { roleId: 'bulk', priority: 2 }],
  windows: [{
    windowId: 'weekly', bucketId: 'shared-token-quota', unit: 'token',
    hardLimit: { minimumRemaining: 0 },
    reservePolicy: {
      hardReserve: { minimumRemaining: 10, protectedRoleIds: ['independent-audit'] },
      softConservation: { enterBelowRemaining: 30 },
    },
  }],
});

test('hard limit, hard reserve, and soft conservation remain distinct approved policy inputs', () => {
  const accepted = validator.resourcePolicyV1(policy());
  assert.equal(accepted.windows[0].hardLimit.minimumRemaining, 0);
  assert.equal(accepted.windows[0].reservePolicy.hardReserve.minimumRemaining, 10);
  assert.equal(accepted.windows[0].reservePolicy.softConservation.enterBelowRemaining, 30);
  assert.deepEqual(accepted.allowedAccessPaths, ['subscription']);
  assert.equal(accepted.preferenceOverride, undefined);
});

test('no shared quota threshold is imposed and inconsistent floors are rejected', () => {
  const softOnly = policy();
  softOnly.windows[0] = { windowId: 'five-hour', bucketId: 'request-quota', unit: 'request', reservePolicy: { softConservation: { enterBelowRemaining: 3 } } };
  assert.equal(validator.resourcePolicyV1(softOnly).windows[0].hardLimit, undefined);
  const backwards = policy();
  backwards.windows[0].reservePolicy.softConservation.enterBelowRemaining = 5;
  assert.throws(() => validator.resourcePolicyV1(backwards));
});

test('paid access and priority exceptions require separate explicit approvals', () => {
  const paid = policy(); paid.allowedAccessPaths = ['subscription', 'api'];
  assert.throws(() => validator.resourcePolicyV1(paid));
  paid.paidAccessApproval = approval();
  assert.equal(validator.resourcePolicyV1(paid).allowedAccessPaths[1], 'api');

  const exception = policy();
  exception.preferenceOverride = { mode: 'preferred-through-hard-reserve', reason: 'approved urgent review' };
  assert.throws(() => validator.resourcePolicyV1(exception));
  exception.preferenceOverride.approval = approval();
  assert.equal(validator.resourcePolicyV1(exception).preferenceOverride.mode, 'preferred-through-hard-reserve');
});

test('unknown/stale cannot grant access, and duplicate identities are rejected', () => {
  const unknown = policy(); unknown.onUnknown = 'allow';
  assert.throws(() => validator.resourcePolicyV1(unknown));
  const duplicate = policy(); duplicate.windows.push({ ...duplicate.windows[0] });
  assert.throws(() => validator.resourcePolicyV1(duplicate));
  const roles = policy(); roles.rolePriorities.push({ roleId: 'bulk', priority: 1 });
  assert.throws(() => validator.resourcePolicyV1(roles));
  const secret = policy(); secret.accountToken = 'secret';
  assert.throws(() => validator.resourcePolicyV1(secret));
});
