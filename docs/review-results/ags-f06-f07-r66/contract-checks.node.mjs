import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { canonicalJson, convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { FlowmarshalCurrentInvocation } from '../../../mcp-server/src/host-integration/flowmarshal-current-invocation.ts';
import { verifyFlowmarshalReceipt } from '../../../mcp-server/src/host-integration/observation-challenge.ts';
import { buildCurrentHostIntegrationManifest, parseHostIntegrationManifest } from '../../../mcp-server/src/host-integration/manifest.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';

const root = process.cwd();
const read = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'));
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const now = Date.parse('2026-10-01T00:00:01.000Z');
const task = { schemaVersion: '1.0.0', taskId: 'synthetic-task', objective: 'Synthetic contract check',
  scope: { included: ['fixture'], excluded: [] }, acceptanceCriteria: ['Synthetic only'], riskLevel: 'low',
  workUnits: [], requiredCapabilities: [], constraints: [],
  authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
  decision: { complexity: 'simple', hasConflicts: false }, orchestration: { requested: false, mcpAvailable: true } };

function invocationFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-contract-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const profile = { profileId: 'flowmarshal-same-user-v1', assuranceTier: 'same-user',
    freezeIdentity: `sha256:${'a'.repeat(64)}`,
    pins: [{ keyId: 'synthetic-key', status: 'active',
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    resources: { state: { namespace: 'flowmarshal-same-user-v1', location: path.join(directory, 'state.sqlite3') } } };
  const invocation = new FlowmarshalCurrentInvocation(profile, new InMemoryWorkflowStore(), () => now+1);
  const signed = (body) => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url'), keyId: 'synthetic-key' };
  };
  const registration = (nonce, terminalTime='2026-10-01T00:00:00.000Z') => ({ version: 1,
    domain: 'ags-fm-same-user-dispatch-registration-v1',
    profileBinding: { profileId: profile.profileId, freezeIdentity: profile.freezeIdentity },
    assertions: { modelClass: 'deep', actorId: 'synthetic-actor' }, serverEpoch: invocation.serverEpoch,
    nonce, issuedAt: new Date(now).toISOString(), expiresAt: new Date(now+60_000).toISOString(),
    producer: { installationId: 'synthetic-installation', keyId: 'synthetic-key', hostId: 'flowmarshal', instanceId: 'synthetic-instance' },
    binding: { turnId: 'synthetic-turn', taskId: 'synthetic-task', runId: null, attemptId: null,
      hostId: 'flowmarshal', sessionId: 'synthetic-session', instanceId: 'synthetic-instance' },
    terminal: { eventId: 'synthetic-event', callId: 'synthetic-provider-call', threadId: 'synthetic-thread',
      turnId: 'synthetic-turn', status: 'succeeded', observedAt: terminalTime, model: 'synthetic-model',
      effort: 'high', provenance: 'provider_raw_response', digest: `sha256:${'b'.repeat(64)}` },
    core: { goalRevision: 1, taskRevision: 1, attemptOrdinal: null, gateOperationKey: 'synthetic-operation', stage: 'bootstrap' },
    invocation: { tool: 'plan_workflow', inputDigest: convergenceDigest(task), observedAt: new Date(now).toISOString() } });
  const receipt = (registered, callId, nonce) => ({ version: 2,
    domain: 'fm-same-user-provider-terminal-to-governance-v1',
    profileBinding: registered.profileBinding, assertions: registered.assertions,
    producer: registered.producer, binding: { invocationId: callId, ...registered.binding },
    terminal: registered.terminal, core: registered.core, invocation: registered.invocation,
    nonce, issuedAt: registered.issuedAt, expiresAt: registered.expiresAt,
    transport: { serverEpoch: invocation.serverEpoch, registrationDigest: sha(Buffer.from(canonicalJson(registered))) } });
  return { directory, profile, invocation, registration, receipt, signed,
    close() { invocation.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('as-committed package manifest binds every current execution artifact', () => {
  const manifest = read('host-integration.json');
  assert.deepEqual(parseHostIntegrationManifest(manifest, root), buildCurrentHostIntegrationManifest(root));
  const entry = manifest.entryPoints.find(({id}) => id==='mcp-server');
  assert.equal(entry.path, 'mcp-server/dist/server.mjs');
  assert.ok(entry.executionClosure.includes('mcp-server/dist/flowmarshal-profile-probe.mjs'));
  console.log(JSON.stringify({ id: 'manifest', entryPoints: manifest.entryPoints.map(({id})=>id),
    artifacts: manifest.artifacts.length, manifestSha256: sha(readFileSync('host-integration.json')) }));
});

test('each advertised artifact is required and omission is detected before profile/state access', () => {
  const manifest = read('host-integration.json');
  const directory = mkdtempSync(path.join(tmpdir(), 'ags-package-'));
  try {
    for (const artifact of manifest.artifacts) {
      const destination = path.join(directory, artifact.path);
      mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(path.join(root, artifact.path), destination);
    }
    parseHostIntegrationManifest(manifest, directory);
    for (const artifact of manifest.artifacts) {
      const file = path.join(directory, artifact.path), missing = `${file}.review-missing`;
      renameSync(file, missing);
      try { assert.throws(() => parseHostIntegrationManifest(manifest, directory), /Missing package file/,
        `missing ${artifact.path}`); }
      finally { renameSync(missing, file); }
    }
    assert.equal(existsSync(path.join(directory, 'flowmarshal-same-user-v1')), false);
    console.log(JSON.stringify({ id: 'missing-artifacts', checked: manifest.artifacts.length, operatingProfileRead: false }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('all registration and receipt identity components are bound, and invalid receipts preserve the ticket', async () => {
  const f = invocationFixture();
  try {
    const reg = f.registration('matrix-registration');
    const ticket = f.invocation.reserve(f.signed(reg));
    const valid = f.receipt(reg, ticket.callId, 'matrix-receipt');
    const mutations = [
      ['domain', (v)=>{ v.domain='vm-provider-terminal-to-governance'; }],
      ['version', (v)=>{ v.version=1; }],
      ['profile', (v)=>{ v.profileBinding.profileId='vm-protected-v1'; }],
      ['freeze', (v)=>{ v.profileBinding.freezeIdentity=`sha256:${'c'.repeat(64)}`; }],
      ['registration digest', (v)=>{ v.transport.registrationDigest=`sha256:${'c'.repeat(64)}`; }],
      ['epoch', (v)=>{ v.transport.serverEpoch='synthetic-other-epoch'; }],
      ['current call', (v)=>{ v.binding.invocationId='synthetic-other-call'; }],
      ['task', (v)=>{ v.binding.taskId='synthetic-other-task'; }],
      ['run', (v)=>{ v.binding.runId='synthetic-other-run'; }],
      ['attempt', (v)=>{ v.binding.attemptId='synthetic-other-attempt'; }],
      ['session', (v)=>{ v.binding.sessionId='synthetic-other-session'; }],
      ['instance', (v)=>{ v.binding.instanceId='synthetic-other-instance'; }],
      ['actor', (v)=>{ v.assertions.actorId='synthetic-other-actor'; }],
      ['model class', (v)=>{ v.assertions.modelClass='general'; }],
      ['model', (v)=>{ v.terminal.model='synthetic-other-model'; }],
      ['effort', (v)=>{ v.terminal.effort='low'; }],
      ['terminal digest', (v)=>{ v.terminal.digest=`sha256:${'c'.repeat(64)}`; }],
      ['tool', (v)=>{ v.invocation.tool='record_stage_result'; }],
      ['unsigned input', (v)=>{ v.invocation.inputDigest=`sha256:${'c'.repeat(64)}`; }],
      ['core revision', (v)=>{ v.core.taskRevision=2; }],
    ];
    for (const [label, mutate] of mutations) {
      const wrong = structuredClone(valid); mutate(wrong);
      await assert.rejects(f.invocation.runCurrentRequest(ticket.callId, 'plan_workflow',
        { ...task, _hostAttestation: f.signed(wrong) }, async()=>f.invocation.verifyCurrentReceipt()), /A2|mismatch/, label);
    }
    const observed = await f.invocation.runCurrentRequest(ticket.callId, 'plan_workflow',
      { ...task, _hostAttestation: f.signed(valid) }, async()=>f.invocation.verifyCurrentReceipt());
    assert.equal(observed.model, 'synthetic-model');
    await assert.rejects(f.invocation.runCurrentRequest(ticket.callId, 'plan_workflow',
      { ...task, _hostAttestation: f.signed(valid) }, async()=>f.invocation.verifyCurrentReceipt()), /already used/);
    console.log(JSON.stringify({ id: 'binding-matrix', negativeCases: mutations.length, preservedTicket: true, oneUse: true }));
  } finally { f.close(); }
});

test('reproduce dispatch/receipt terminal timestamp precision mismatch without a producer or provider', () => {
  const f = invocationFixture();
  try {
    const reg = f.registration('precision-registration', '2026-10-01T00:00:00.000123Z');
    let dispatchAccepted = false;
    try { f.invocation.reserve(f.signed(reg)); dispatchAccepted = true; }
    catch (error) { assert.match(error.message, /registration binding is invalid/); }
    assert.equal(dispatchAccepted, false);
    const receipt = f.receipt(reg, 'synthetic-call', 'precision-receipt');
    const envelope = f.signed(receipt);
    const accepted = verifyFlowmarshalReceipt({ envelope, profile: f.profile, registration: reg,
      registrationDigest: receipt.transport.registrationDigest, callId: 'synthetic-call',
      serverEpoch: f.invocation.serverEpoch, tool: 'plan_workflow',
      arguments: { ...task, _hostAttestation: envelope }, now: now+1,
      verifyEnvelope: (value)=>f.invocation.verifySignedEnvelope(value) });
    assert.equal(accepted.terminal.observedAt, reg.terminal.observedAt);
    const receiptAccepted = accepted.terminal.observedAt === reg.terminal.observedAt;
    console.log(JSON.stringify({ id: 'precision-mismatch', terminalObservedAt: reg.terminal.observedAt,
      dispatch: 'REJECTED', receiptPureVerifier: 'ACCEPTED', productBypass: false,
      actualProducerFormat: 'UNVERIFIED' }));
    if (process.env.AGS_REVIEW_REQUIRE_PRECISION_PARITY === '1') {
      assert.equal(dispatchAccepted, receiptAccepted,
        'Proposed regression: freeze one shared terminal timestamp grammar before choosing a code fix');
    }
  } finally { f.close(); }
});

test('public schema inventory exposes profile selection but does not publish A2 signed-body schemas', () => {
  const schemas = readdirSync('contracts').filter((name)=>name.endsWith('.schema.json'));
  const dispatchDomain = 'ags-fm-same-user-dispatch-registration-v1';
  const receiptDomain = 'fm-same-user-provider-terminal-to-governance-v1';
  const domains = schemas.filter((name)=>{
    const contents = readFileSync(path.join('contracts',name), 'utf8');
    return contents.includes(dispatchDomain)||contents.includes(receiptDomain);
  });
  assert.deepEqual(domains, ['host-integration.v1.schema.json']);
  const schema = read('contracts/host-integration.v1.schema.json');
  assert.deepEqual(Object.keys(schema.$defs).sort(), ['profileBinding','serverProfileSelection','trustProfile']);
  console.log(JSON.stringify({ id: 'wire-schema-inventory', matchingSchemas: domains,
    publicDefinitions: Object.keys(schema.$defs), typedA2DispatchOrReceiptDefinition: false,
    consumerValidation: 'HAND_CODED', releaseContractSatisfaction: 'UNVERIFIED' }));
});
