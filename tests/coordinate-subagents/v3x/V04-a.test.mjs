import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { ObservationReceiptSigner } from '../../../mcp-server/src/host-integration/observation-signer.ts';
import { registerHostObservationReader, registerTestObservationReader,
  registerVmObservationReader } from '../../../mcp-server/src/host-integration/observation-challenge.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { RoutingObservationSigner } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/V03-vm-producer-receipt.json', import.meta.url), 'utf8'));

function hostFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-v04a-'));
  const pinPath = join(directory, 'pins.json');
  writeFileSync(pinPath, JSON.stringify({ version: 1, pins: [{
    keyId: fixture.receipt.keyId, installationId: fixture.installationId,
    hostId: fixture.hostId, publicKeySpki: fixture.publicKeySpki,
  }] }));
  chmodSync(pinPath, 0o600);
  const prior = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  process.env.AGENT_GOVERNANCE_VM_PIN_PATH = pinPath;
  let current = { receipt: fixture.receipt, tool: fixture.tool,
    arguments: fixture.arguments, binding: fixture.binding };
  let now = new Date(fixture.now);
  const store = new InMemoryWorkflowStore();
  const reader = registerVmObservationReader({ readCurrentInvocation: () => current });
  const signer = new ObservationReceiptSigner(store, reader, 'host', () => now);
  return {
    signer, store,
    change(next) { current = next; },
    setTime(next) { now = next; },
    close() {
      if (prior === undefined) delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
      else process.env.AGENT_GOVERNANCE_VM_PIN_PATH = prior;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('signs only a verified and consumed VM host challenge with the observed model and turn', () => {
  const host = hostFixture();
  try {
    const token = host.signer.issueChallenge();
    const receipt = host.signer.sign(token);
    const body = JSON.parse(Buffer.from(fixture.receipt.body, 'base64url').toString('utf8'));
    assert.equal(receipt.kind, 'observation');
    assert.equal(receipt.payload.domain, 'host-observation-receipt');
    assert.equal(receipt.payload.challenge.binding.turnId, body.binding.turnId);
    assert.equal(receipt.payload.challenge.model, body.terminal.model);
    assert.equal(receipt.payload.challenge.reasoningEffort, body.terminal.effort);
    assert.equal(receipt.expiresAt, receipt.payload.challenge.expiresAt);
    const key = Buffer.from(host.store.getOrCreateSecret('host_observation_receipt_v1', () => 'unreachable'), 'base64url');
    const verifier = new RoutingObservationSigner(key);
    assert.deepEqual(verifier.verify(receipt, 'observation', fixture.now), receipt.payload);
    assert.throws(() => verifier.verify({ ...receipt, payload: { ...receipt.payload, domain: 'test-observation-receipt' } },
      'observation', fixture.now), /INVALID_RECEIPT_MAC/);
    assert.throws(() => host.signer.sign(token), /already consumed/);
  } finally { host.close(); }
});

test('does not sign a self-report, a source label, or a fake reader as host', () => {
  const store = new InMemoryWorkflowStore();
  const selfReport = { source: 'runtime', model: 'claimed-model', reasoningEffort: 'high',
    binding: fixture.binding };
  assert.throws(() => new ObservationReceiptSigner(store, selfReport, 'host'), /trusted host observation unavailable/);
  assert.throws(() => registerHostObservationReader(() => selfReport), /trusted host observation unavailable/);
  const fake = registerTestObservationReader(() => ({ ...selfReport, observationId: 'fake', observedAt: fixture.now }));
  assert.throws(() => new ObservationReceiptSigner(store, fake, 'host'), /trusted host observation unavailable/);
});

test('rejects another signed turn, another challenge, and an expired challenge', () => {
  const host = hostFixture();
  try {
    const token = host.signer.issueChallenge();
    host.change({ receipt: fixture.receipt, tool: fixture.tool, arguments: fixture.arguments,
      binding: { ...fixture.binding, turnId: 'another-turn' } });
    assert.throws(() => host.signer.sign(token), /turnId binding mismatch/);
    host.change({ receipt: fixture.receipt, tool: fixture.tool, arguments: fixture.arguments,
      binding: fixture.binding });
    const other = hostFixture();
    try { assert.throws(() => other.signer.sign(token), /signature mismatch/); }
    finally { other.close(); }
    host.setTime(new Date(Date.parse(fixture.now) + 60_000));
    assert.throws(() => host.signer.sign(token), /expired/);
  } finally { host.close(); }
});

test('test receipt has a separate domain and signing key', () => {
  const now = new Date(fixture.now);
  const store = new InMemoryWorkflowStore();
  const reader = registerTestObservationReader(() => ({ binding: fixture.binding,
    observationId: 'fake-observation', observedAt: now.toISOString(),
    model: 'fake-model', reasoningEffort: 'high' }));
  const testSigner = new ObservationReceiptSigner(store, reader, 'test', () => now);
  const receipt = testSigner.sign(testSigner.issueChallenge());
  assert.equal(receipt.payload.domain, 'test-observation-receipt');
  const hostKey = Buffer.from(store.getOrCreateSecret('host_observation_receipt_v1',
    () => Buffer.alloc(32, 7).toString('base64url')), 'base64url');
  assert.throws(() => new RoutingObservationSigner(hostKey).verify(receipt, 'observation', now.toISOString()),
    /INVALID_RECEIPT_MAC/);
});
