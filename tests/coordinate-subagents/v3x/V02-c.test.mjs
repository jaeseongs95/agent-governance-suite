import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../docs/implementation-3x/fixtures/vm-observation-producer-contract.json', import.meta.url), 'utf8'));
const contract = readFileSync(new URL('../../../docs/implementation-3x/vm-observation-producer-contract.ko.md', import.meta.url), 'utf8');
const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
const bindingFields = ['invocationId', 'turnId', 'taskId', 'runId', 'attemptId', 'hostId', 'sessionId', 'instanceId'];
const signedBodyFields = ['version', 'domain', 'producer', 'binding', 'terminal', 'core', 'invocation', 'nonce', 'issuedAt', 'expiresAt'];
const bodyFor = (example) => ({
  version: 1,
  domain: 'vm-provider-terminal-to-governance',
  producer: example.producer,
  binding: example.binding,
  terminal: example.terminal,
  core: example.core,
  invocation: {
    tool: example.invocation.tool,
    inputDigest: example.invocation.inputDigest,
    observedAt: example.invocation.observedAt,
  },
  nonce: example.nonce,
  issuedAt: example.issuedAt,
  expiresAt: example.expiresAt,
});

test('pins source identity while keeping examples outside the production trust domain', () => {
  assert.equal(fixture.kind, 'vm-observation-producer-contract-fixture');
  assert.equal(fixture.fixtureDomain, 'contract-only-no-credential');
  assert.equal(fixture.cryptographicEvidence, 'not-included');
  assert.deepEqual(fixture.bindingFields, bindingFields);
  assert.equal(fixture.sources.length, 11);
  for (const [repo, ref] of Object.entries(fixture.pinnedRefs)) {
    assert.match(ref, /^[a-f0-9]{40}$/);
    assert.ok(contract.includes(ref), `${repo} ref is absent from the frozen contract`);
  }
  for (const source of fixture.sources) {
    assert.match(source.sha256, /^[a-f0-9]{64}$/);
    assert.ok(contract.includes(source.path));
    assert.ok(contract.includes(source.sha256));
  }
});

test('freezes two completed turns before distinct governance calls and cross-language input vectors', () => {
  assert.deepEqual(fixture.validCases.map(({ kind }) => kind), ['steward', 'worker']);
  for (const example of fixture.validCases) {
    assert.deepEqual(Object.keys(example.producer), ['installationId', 'keyId', 'hostId', 'instanceId']);
    for (const field of Object.keys(example.producer)) assert.ok(example.producer[field], `missing producer.${field}`);
    assert.deepEqual(Object.keys(example.binding), bindingFields);
    assert.deepEqual(Object.keys(example.terminal), ['eventId', 'callId', 'threadId', 'turnId', 'status',
      'observedAt', 'model', 'effort', 'provenance', 'digest']);
    for (const field of ['eventId', 'callId', 'threadId']) assert.ok(example.terminal[field], `missing terminal.${field}`);
    assert.ok(['succeeded', 'completed'].includes(example.terminal.status));
    assert.deepEqual(Object.keys(example.core), ['goalRevision', 'taskRevision', 'attemptOrdinal', 'gateOperationKey', 'stage']);
    assert.ok(Number.isSafeInteger(example.core.goalRevision) && example.core.goalRevision > 0);
    assert.ok(Number.isSafeInteger(example.core.taskRevision) && example.core.taskRevision > 0);
    assert.ok(example.core.gateOperationKey);
    assert.equal(example.core.stage, example.kind === 'steward' ? 'bootstrap' : 'implementation');
    if (example.kind === 'steward') assert.equal(example.core.attemptOrdinal, null);
    else assert.ok(Number.isSafeInteger(example.core.attemptOrdinal) && example.core.attemptOrdinal > 0);
    assert.equal(example.binding.turnId, example.terminal.turnId);
    assert.notEqual(example.binding.turnId, example.binding.invocationId);
    assert.equal(example.binding.hostId, example.producer.hostId);
    assert.equal(example.binding.instanceId, example.producer.instanceId);
    assert.ok(Date.parse(example.terminal.observedAt) < Date.parse(example.invocation.observedAt));
    assert.equal(example.issuedAt, example.invocation.observedAt);
    assert.equal(Date.parse(example.expiresAt) - Date.parse(example.issuedAt), 60_000);
    assert.equal(example.invocation.inputDigest, digest(example.invocation.input));
    const { digest: terminalDigest, ...terminalBody } = example.terminal;
    assert.equal(terminalDigest, digest(terminalBody));
    assert.ok(['provider_raw_response', 'claude_session_transcript'].includes(example.terminal.provenance));
  }
  for (const vector of fixture.canonicalVectors) {
    assert.equal(vector.canonicalJson, canonicalJson(vector.value));
    assert.equal(vector.digest, digest(vector.value));
  }
});

test('fixes signed body bytes and V03 host observation projection', () => {
  assert.equal(fixture.bodyGolden.length, fixture.validCases.length);
  const cases = new Map(fixture.validCases.map((entry) => [entry.id, entry]));
  for (const golden of fixture.bodyGolden) {
    const example = cases.get(golden.caseId);
    assert.ok(example, `unknown golden case ${golden.caseId}`);
    assert.deepEqual(Object.keys(golden.body), signedBodyFields);
    assert.deepEqual(golden.body, bodyFor(example));
    assert.equal(golden.canonicalJson, canonicalJson(golden.body));
    const bytes = Buffer.from(golden.canonicalJson, 'utf8');
    assert.equal(golden.bodyBase64url, bytes.toString('base64url'));
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(golden.sha256, hash);
    assert.deepEqual(golden.expectedObservation, {
      binding: example.binding,
      observationId: `vm-producer-v1:${hash}`,
      observedAt: example.invocation.observedAt,
      model: example.terminal.model,
      reasoningEffort: example.terminal.effort,
    });
  }
  assert.equal(new Set(fixture.bodyGolden.map(({ sha256 }) => sha256)).size, fixture.bodyGolden.length);
});

test('enumerates every cross-binding rejection, including validly signed other-host evidence', () => {
  const cases = new Map(fixture.validCases.map((entry) => [entry.id, entry]));
  const rejections = new Map(fixture.rejectCases.map((entry) => [entry.id, entry]));
  assert.equal(rejections.size, fixture.rejectCases.length);
  for (const field of bindingFields) {
    const rejection = rejections.get(`cross-${field}`);
    assert.ok(rejection, `missing cross-${field}`);
    assert.equal(rejection.expectedDisposition, 'binding_mismatch');
    assert.equal(rejection.signaturePrecondition, 'valid-for-mutated-body');
    assert.deepEqual(rejection.changes.map(({ path }) => path), [`binding.${field}`]);
    assert.notDeepEqual(rejection.changes[0].value, cases.get(rejection.base).binding[field]);
  }
  const otherHost = rejections.get('signed-other-host');
  assert.equal(otherHost.expectedDisposition, 'host_mismatch');
  assert.equal(otherHost.signaturePrecondition, 'valid-under-other-pinned-host-key');
  assert.deepEqual(otherHost.changes.map(({ path }) => path).sort(), ['binding.hostId', 'producer.hostId', 'producer.keyId']);
  assert.ok(fixture.rejectCases.every((entry) => cases.has(entry.base) && entry.expectedDisposition));
  for (const id of ['other-tool', 'other-input', 'requested-only-model', 'incomplete-terminal',
    'caller-json', 'source-string', 'signer-cli', 'claude-hook', 'expired', 'replay',
    'revoked-key', 'stale-core-revision', 'outer-key-id-mismatch']) assert.ok(rejections.has(id), `missing ${id}`);
});
