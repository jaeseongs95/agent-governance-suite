import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  ObservationChallengeAuthority, registerHostObservationReader, registerTestObservationReader,
  registerVmObservationReader,
} from '../../../mcp-server/src/host-integration/observation-challenge.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';

const contract = JSON.parse(readFileSync(new URL('../../../docs/implementation-3x/fixtures/vm-observation-producer-contract.json', import.meta.url), 'utf8'));

function vmFixture(example = contract.validCases[0]) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-v03-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyId = example.producer.keyId;
  const pinPath = join(directory, 'operator-pins.json');
  writeFileSync(pinPath, JSON.stringify({ version: 1, pins: [{
    keyId, installationId: example.producer.installationId, hostId: 'flowmarshal-engine',
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }] }));
  chmodSync(pinPath, 0o600);
  const prior = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  process.env.AGENT_GOVERNANCE_VM_PIN_PATH = pinPath;
  const body = contract.bodyGolden.find((item) => item.caseId === example.id).bodyBase64url;
  const bytes = Buffer.from(body, 'base64url');
  const receipt = { body, signature: sign(null, bytes, privateKey).toString('base64url'), keyId };
  let current = {
    receipt, tool: example.invocation.tool,
    arguments: { ...example.invocation.input, _hostAttestation: receipt },
    binding: { ...example.binding },
  };
  const reader = registerVmObservationReader({ readCurrentInvocation: () => current });
  let time = new Date(Date.parse(example.issuedAt) + 1);
  const challenge = new ObservationChallengeAuthority(new InMemoryWorkflowStore(), reader, 'host', () => time);
  return {
    challenge, receipt, example, publicKey, privateKey, pinPath, directory,
    get current() { return current; },
    change(next) { current = next; },
    setTime(next) { time = next; },
    close() {
      if (prior === undefined) delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
      else process.env.AGENT_GOVERNANCE_VM_PIN_PATH = prior;
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function signedVariant(vm, edit) {
  const body = JSON.parse(Buffer.from(vm.receipt.body, 'base64url').toString('utf8'));
  edit(body);
  const bytes = Buffer.from(canonicalJson(body));
  return { body: bytes.toString('base64url'),
    signature: sign(null, bytes, vm.privateKey).toString('base64url'), keyId: vm.receipt.keyId };
}

const issuedAt = new Date('2026-09-23T00:00:00.000Z');
const observed = () => ({
  binding: {
    invocationId: 'invocation-1', turnId: 'turn-1', taskId: 'task-1', runId: 'run-1',
    attemptId: 'attempt-1', hostId: 'flowmarshal-engine', sessionId: 'session-1', instanceId: 'instance-1',
  },
  observationId: 'host-event-1', observedAt: issuedAt.toISOString(),
  model: 'observed-model', reasoningEffort: 'high',
});

function authority(domain = 'test', store = new InMemoryWorkflowStore()) {
  let current = observed();
  let time = issuedAt;
  const reader = (domain === 'host' ? registerHostObservationReader : registerTestObservationReader)(() => current);
  return {
    challenge: new ObservationChallengeAuthority(store, reader, domain, () => time),
    change(next) { current = next; },
    setTime(next) { time = next; },
    store, reader,
  };
}

test('test-domain challenge binds the same invocation and consumes once', () => {
  const service = authority();
  const { challenge } = service;
  const token = challenge.issue();
  service.setTime(new Date(issuedAt.getTime() + 1));
  const body = challenge.verifyAndConsume(token);
  assert.equal(body.binding.invocationId, 'invocation-1');
  assert.equal(body.model, 'observed-model');
  assert.equal(body.reasoningEffort, 'high');
  assert.equal(body.expiresAt, new Date(issuedAt.getTime() + 60_000).toISOString());
  service.setTime(new Date(issuedAt.getTime() + 2));
  assert.throws(() => challenge.verifyAndConsume(token), /already consumed/);
});

test('separate issuer and verifier instances share a durable one-use claim boundary', () => {
  const store = new InMemoryWorkflowStore();
  const issuer = authority('test', store);
  const verifier = authority('test', store);
  const token = issuer.challenge.issue();
  assert.equal(verifier.challenge.verifyAndConsume(token).binding.turnId, 'turn-1');
  assert.throws(() => issuer.challenge.verifyAndConsume(token), /already consumed/);
});

test.each(['invocationId', 'turnId', 'taskId', 'runId', 'attemptId', 'hostId', 'sessionId', 'instanceId'])(
  'rejects a different %s observed by the verifier', (field) => {
    const service = authority();
    const token = service.challenge.issue();
    service.change({ ...observed(), binding: { ...observed().binding, [field]: `other-${field}` } });
    assert.throws(() => service.challenge.verifyAndConsume(token), /different host invocation/);
  },
);

test('format-valid self-report is not a host reader, and observed model is not caller configuration', () => {
  assert.throws(() => new ObservationChallengeAuthority(new InMemoryWorkflowStore(), { ...observed(), source: 'runtime' }, 'host'), /trusted host observation unavailable/);
  const service = authority();
  const token = service.challenge.issue();
  service.change({ ...observed(), model: 'requested-model' });
  assert.throws(() => service.challenge.verifyAndConsume(token), /different host invocation/);
  const [prefix, encoded, signature] = token.split('.');
  assert.throws(() => service.challenge.verifyAndConsume(`${prefix}.${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}.${signature}`), /signature mismatch/);
});

test('a callback wrapping a format-valid self-report cannot mint a host challenge', () => {
  const store = new InMemoryWorkflowStore();
  const selfReport = { ...observed(), source: 'runtime' };
  assert.throws(() => {
    const reader = registerHostObservationReader(() => selfReport);
    const challenge = new ObservationChallengeAuthority(store, reader, 'host', () => issuedAt);
    const token = challenge.issue();
    challenge.verifyAndConsume(token);
  }, /trusted host observation unavailable/);
});

test('test producer cannot construct a host verifier, even with the same store and observation', () => {
  const store = new InMemoryWorkflowStore();
  const testProducer = authority('test', store);
  const token = testProducer.challenge.issue();
  assert.throws(() => new ObservationChallengeAuthority(store, testProducer.reader, 'host'), /trusted host observation unavailable/);
  assert.throws(() => authority('host', store), /trusted host observation unavailable/);
  assert.equal(testProducer.challenge.verifyAndConsume(token).domain, 'test');
});

test('rejects expired, stale and future observations', () => {
  const service = authority();
  const token = service.challenge.issue();
  service.setTime(new Date(issuedAt.getTime() + 60_000));
  assert.throws(() => service.challenge.verifyAndConsume(token), /expired/);
  service.setTime(new Date(issuedAt.getTime() + 5 * 60_000 + 1));
  assert.throws(() => service.challenge.issue(), /stale/);
  service.change({ ...observed(), observedAt: new Date(issuedAt.getTime() + 5_001).toISOString() });
  service.setTime(issuedAt);
  assert.throws(() => service.challenge.issue(), /future/);
});

test.each(contract.validCases)('VM signed $id receipt creates and consumes a host challenge', (example) => {
  const vm = vmFixture(example);
  try {
    const token = vm.challenge.issue();
    const result = vm.challenge.verifyAndConsume(token);
    const golden = contract.bodyGolden.find((item) => item.caseId === example.id);
    assert.equal(result.domain, 'host');
    assert.deepEqual(result.binding, example.binding);
    assert.equal(result.observationId, golden.expectedObservation.observationId);
    assert.equal(result.model, example.terminal.model);
    assert.equal(result.reasoningEffort, example.terminal.effort);
    assert.throws(() => vm.challenge.verifyAndConsume(token), /already consumed/);
    assert.throws(() => vm.challenge.issue(), /already consumed/);
  } finally { vm.close(); }
});

test.each(contract.bindingFields)('VM host rejects cross-bound %s', (field) => {
  const vm = vmFixture();
  try {
    const token = vm.challenge.issue();
    vm.change({ ...vm.current, binding: { ...vm.current.binding, [field]: `other-${field}` } });
    assert.throws(() => vm.challenge.verifyAndConsume(token), new RegExp(`${field} binding mismatch`));
  } finally { vm.close(); }
});

test('VM host rejects signed wrong-host, changed tool/input, self-report, revoked pin and expiry', () => {
  const vm = vmFixture();
  try {
    const token = vm.challenge.issue();
    const other = JSON.parse(Buffer.from(vm.receipt.body, 'base64url').toString('utf8'));
    other.producer.hostId = other.binding.hostId = 'other-host';
    const otherBytes = Buffer.from(canonicalJson(other));
    const otherReceipt = { body: otherBytes.toString('base64url'),
      signature: sign(null, otherBytes, vm.privateKey).toString('base64url'), keyId: vm.receipt.keyId };
    vm.change({ ...vm.current, receipt: otherReceipt,
      arguments: { ...vm.example.invocation.input, _hostAttestation: otherReceipt },
      binding: { ...vm.current.binding, hostId: 'other-host' } });
    assert.throws(() => vm.challenge.verifyAndConsume(token), /source or binding is invalid/);
    vm.change({ ...vm.current, receipt: vm.receipt,
      arguments: { ...vm.example.invocation.input, _hostAttestation: vm.receipt }, binding: vm.example.binding });
    vm.change({ ...vm.current, tool: 'other_tool' });
    assert.throws(() => vm.challenge.verifyAndConsume(token), /tool or input mismatch/);
    vm.change({ ...vm.current, tool: vm.example.invocation.tool,
      arguments: { ...vm.current.arguments, changed: true } });
    assert.throws(() => vm.challenge.verifyAndConsume(token), /tool or input mismatch/);
    vm.change({ ...vm.current, binding: { ...vm.current.binding, hostId: 'other-host' } });
    assert.throws(() => vm.challenge.verifyAndConsume(token), /hostId binding mismatch/);
    vm.change({ ...vm.current, receipt: { ...vm.receipt, signature: 'A'.repeat(86) } });
    assert.throws(() => vm.challenge.verifyAndConsume(token), /signature mismatch|malformed/);
    vm.change({ ...vm.current, receipt: vm.receipt, tool: vm.example.invocation.tool,
      arguments: { ...vm.example.invocation.input, _hostAttestation: vm.receipt }, binding: vm.example.binding });
    const pins = readFileSync(vm.pinPath, 'utf8');
    writeFileSync(vm.pinPath, JSON.stringify({ version: 1, pins: [] }));
    assert.throws(() => vm.challenge.verifyAndConsume(token), /not pinned/);
    writeFileSync(vm.pinPath, pins);
    vm.setTime(new Date(Date.parse(vm.example.issuedAt) + 60_000));
    assert.throws(() => vm.challenge.verifyAndConsume(token), /expired/);
  } finally { vm.close(); }
  const old = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  try {
    assert.throws(() => registerVmObservationReader({ readCurrentInvocation: () => ({ source: 'runtime', binding: observed().binding }) }), /pin file is unavailable/);
  } finally {
    if (old !== undefined) process.env.AGENT_GOVERNANCE_VM_PIN_PATH = old;
  }
});

test('SQLite claims producer nonce and host challenge across separate processes', () => {
  const vm = vmFixture();
  try {
    const databasePath = join(vm.directory, 'workflow.sqlite3');
    const fixturePath = new URL('./fixtures/V03-claim.mjs', import.meta.url);
    const invoke = (mode, token) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(fixturePath)], {
        input: JSON.stringify({ mode, token, databasePath, invocation: vm.current,
          now: new Date(Date.parse(vm.example.issuedAt) + 2).toISOString() }),
        encoding: 'utf8', env: { ...process.env, AGENT_GOVERNANCE_VM_PIN_PATH: vm.pinPath },
        timeout: 10_000,
      });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const issued = invoke('issue');
    assert.equal(issued.accepted, true, issued.reason);
    assert.match(issued.token, /^agoc1\./);
    const consumed = invoke('verify', issued.token);
    assert.equal(consumed.accepted, true, consumed.reason);
    assert.match(consumed.observationId, /^vm-producer-v1:[0-9a-f]{64}$/);
    assert.match(invoke('verify', issued.token).reason, /already consumed/);
    assert.match(invoke('issue').reason, /already consumed/);
  } finally { vm.close(); }
});

test('VM host rejects receipt outside its 60-second window and future skew', () => {
  const vm = vmFixture();
  try {
    vm.setTime(new Date(Date.parse(vm.example.issuedAt) - 5_001));
    assert.throws(() => vm.challenge.issue(), /stale or from the future/);
    vm.setTime(new Date(vm.example.expiresAt));
    assert.throws(() => vm.challenge.issue(), /receipt expired/);
  } finally { vm.close(); }
});

test('VM raw terminal time accepts Python microseconds and preserves causal order', () => {
  const vm = vmFixture();
  try {
    const pythonReceipt = signedVariant(vm, (body) => {
      body.terminal.observedAt = '2026-09-23T00:00:00.123456+00:00';
    });
    vm.change({ ...vm.current, receipt: pythonReceipt,
      arguments: { ...vm.example.invocation.input, _hostAttestation: pythonReceipt } });
    const token = vm.challenge.issue();
    assert.equal(vm.challenge.verifyAndConsume(token).domain, 'host');
    const roundedReceipt = signedVariant(vm, (body) => {
      body.terminal.observedAt = '2026-09-23T00:00:05.000999+00:00';
      body.nonce = 'rounded-millisecond-nonce';
    });
    vm.change({ ...vm.current, receipt: roundedReceipt,
      arguments: { ...vm.example.invocation.input, _hostAttestation: roundedReceipt } });
    assert.equal(vm.challenge.verifyAndConsume(vm.challenge.issue()).domain, 'host');
    const futureReceipt = signedVariant(vm, (body) => {
      body.terminal.observedAt = '2026-09-23T00:00:05.001000+00:00';
    });
    vm.change({ ...vm.current, receipt: futureReceipt,
      arguments: { ...vm.example.invocation.input, _hostAttestation: futureReceipt } });
    assert.throws(() => vm.challenge.issue(), /causal time is invalid/);
  } finally { vm.close(); }
});

test('accepts a receipt signed by the actual FlowMarshal VM producer', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/V03-vm-producer-receipt.json', import.meta.url), 'utf8'));
  const directory = mkdtempSync(join(tmpdir(), 'ags-v03-vm-interop-'));
  const pinPath = join(directory, 'operator-pins.json');
  writeFileSync(pinPath, JSON.stringify({ version: 1, pins: [{
    keyId: fixture.receipt.keyId, installationId: fixture.installationId,
    hostId: fixture.hostId, publicKeySpki: fixture.publicKeySpki,
  }] }));
  chmodSync(pinPath, 0o600);
  const prior = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  process.env.AGENT_GOVERNANCE_VM_PIN_PATH = pinPath;
  try {
    const reader = registerVmObservationReader({ readCurrentInvocation: () => ({
      receipt: fixture.receipt, tool: fixture.tool, arguments: fixture.arguments,
      binding: fixture.binding,
    }) });
    const challenge = new ObservationChallengeAuthority(
      new InMemoryWorkflowStore(), reader, 'host', () => new Date(fixture.now),
    );
    const token = challenge.issue();
    const result = challenge.verifyAndConsume(token);
    const bodyBytes = Buffer.from(fixture.receipt.body, 'base64url');
    const body = JSON.parse(bodyBytes.toString('utf8'));
    assert.equal(result.observationId, `vm-producer-v1:${createHash('sha256').update(bodyBytes).digest('hex')}`);
    assert.equal(result.model, body.terminal.model);
    assert.equal(result.reasoningEffort, body.terminal.effort);
    assert.equal(body.terminal.observedAt, '2026-09-23T00:00:05.000500+00:00');
    assert.throws(() => challenge.verifyAndConsume(token), /already consumed/);
    assert.throws(() => challenge.issue(), /already consumed/);
  } finally {
    if (prior === undefined) delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
    else process.env.AGENT_GOVERNANCE_VM_PIN_PATH = prior;
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(['digest', 'status', 'provenance'])('VM receipt rejects array-valued terminal %s', (field) => {
  const vm = vmFixture();
  try {
    const receipt = signedVariant(vm, (body) => { body.terminal[field] = [body.terminal[field]]; });
    vm.change({ ...vm.current, receipt,
      arguments: { ...vm.example.invocation.input, _hostAttestation: receipt } });
    assert.throws(() => vm.challenge.issue(), /source or binding is invalid/);
  } finally { vm.close(); }
});
