import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(new URL('../../../contracts/approved-role-source.v1.schema.json', import.meta.url), 'utf8'));
const doc = readFileSync(new URL('../../../docs/implementation-3x/approved-role-source.ko.md', import.meta.url), 'utf8');
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).addSchema(schema);
const snapshotValid = ajv.getSchema(schema.$id);
const reservationValid = ajv.getSchema(`${schema.$id}#/$defs/reservation`);
const effectValid = ajv.getSchema(`${schema.$id}#/$defs/effectStartDecision`);
const principalValid = ajv.getSchema(`${schema.$id}#/$defs/principalClaim`);
const freezeValid = ajv.getSchema(`${schema.$id}#/$defs/contractFreeze`);
const transitions = schema.$defs.reservationTransitions.const;

const d = (c) => `sha256:${c.repeat(64)}`;
const slot = { slotId: `slot-sha256:${'b'.repeat(64)}`, stageId: 'stage-1', assignmentId: 'assign-1' };
function agsSnapshot() {
  return { schemaVersion: '1.0.0', kind: 'approved-role-source-snapshot',
    producer: { owner: 'ags-workflow', producerTask: 'R18', verification: 'ags-server-store-same-transaction-read',
      principal: { profileId: 'ags-local-server', protectedPrincipal: false } },
    scope: { taskId: 'task-1', runId: 'run-1' },
    approval: { origin: 'ags-workflow-approval-record', approvalId: 'approval-1', approvalRevision: 3, approvalDigest: d('a') },
    currentness: { state: 'current', sourceRevision: 7, snapshotId: 'snap-1', snapshotDigest: d('c') },
    revocation: { state: 'not-revoked' }, slots: [slot], inputProvenance: 'server-owned-current-read',
    grants: { executionAuthorized: false, effectAuthorized: false } };
}
function vmSnapshot() {
  return { ...agsSnapshot(),
    producer: { owner: 'flowmarshal-engine', producerTask: 'R16-b', verification: 'vm-signed-control-one-use-registry',
      principal: { profileId: 'vm-protected-v1', protectedPrincipal: true } },
    scope: { projectId: 'project-1', taskId: 'task-1', runId: 'run-1' },
    approval: { origin: 'vm-core-goal-authorization', approvalId: 'goal-auth-1', approvalRevision: 2, approvalDigest: d('a') } };
}
function mutate(base, edit) { const value = structuredClone(base); edit(value); return value; }

const rows = [
  ['ags-r18-producer', 'ags', ['R18'], 'QUALIFIED', null, 'NOT_IMPLEMENTED'],
  ['ags-r19-effect-gate', 'ags', ['R19'], 'QUALIFIED', null, 'NOT_IMPLEMENTED'],
  ['vm-r16a-contract', 'vm', ['R16-a'], 'QUALIFIED', ['AGS', 'codex/v260-semantic-decision-layer', '9e0bfced0577edfdd65e9c59f16393b9825000b5'], 'IMPLEMENTED_INTEGRATED'],
  ['vm-r16b-ledger-port', 'vm', ['R16-b'], 'QUALIFIED', ['FM', 'main', '9d697ea4eb7b359c586da3953ddd7f54617a720f'], 'IMPLEMENTED_INTEGRATED'],
  ['vm-r16c-signed-producer', 'vm', ['R16-c'], 'QUALIFIED', ['FM', 'main', 'e7721cbb7e370b77d200b000a1a6c4c87d72b020'], 'IMPLEMENTED_INTEGRATED'],
  ['vm-r16e-receiver', 'vm', ['R16-e'], 'QUALIFIED', ['AGS', 'codex/v260-semantic-decision-layer', '8532544cc44449fc54cd6f928811791be9c5c87f'], 'IMPLEMENTED_INTEGRATED'],
  ['vm-r16-reader', 'vm', ['R16'], 'QUALIFIED', ['AGS', 'codex/v260-semantic-decision-layer', '0f22be626a6d1a0f9e48af480c56dc37c3e1b3fc'], 'IMPLEMENTED_INTEGRATED'],
  ['vm-r16d-dispatch-claim', 'vm', ['R16-d'], 'UNQUALIFIED_PENDING', null, 'BLOCKED'],
  ['vm-r16f-revocation-race', 'vm', ['R16-f'], 'UNQUALIFIED_PENDING', null, 'BLOCKED'],
  ['vm-r16g', 'vm', ['R16-g'], 'UNQUALIFIED_PENDING', null, 'NOT_STARTED'],
  ['vm-r16f-leaves', 'vm', ['R16-f-contract', 'R16-f-a', 'R16-f-b', 'R16-f-c'], 'UNQUALIFIED_PENDING', null, 'NOT_STARTED'],
].map(([rowId, source, tasks, qualification, integration, implementationState]) => ({
  rowId, source, tasks, qualification, implementationState,
  ...(integration ? { integration: { repository: integration[0], ref: integration[1], sha: integration[2] } } : {}),
  statesProvided: qualification === 'QUALIFIED' ? ['declared-in-doc'] : [],
  reservationGuarantee: qualification === 'QUALIFIED' ? 'see doc' : 'pending',
  unknownGuarantee: qualification === 'QUALIFIED' ? 'see doc' : 'pending',
  enforcementPoints: [], usableAs: qualification === 'QUALIFIED' ? ['contract-freeze-input'] : [],
  runtimeQualification: 'NOT_CLAIMED' }));
const freeze = { task: 'R17', verdict: 'APPROVED_ROLE_SOURCE_PORT_FROZEN', progressRequest: 'COMPLETED', rows,
  agsCoreIndependentOfVmRuntime: true };

test('R17 accepts only server-owned current unrevoked snapshots from either authoritative producer', () => {
  assert.equal(snapshotValid(agsSnapshot()), true, JSON.stringify(snapshotValid.errors));
  assert.equal(snapshotValid(vmSnapshot()), true, JSON.stringify(snapshotValid.errors));
  for (const [name, edit] of [
    ['caller JSON provenance', (v) => { v.inputProvenance = 'caller-json'; }],
    ['caller approved flag', (v) => { v.approved = true; }],
    ['stale revision', (v) => { v.currentness.state = 'stale'; }],
    ['revoked revision', (v) => { v.revocation.state = 'revoked'; }],
    ['arbitrary slot id', (v) => { v.slots[0].slotId = 'slot-anything'; }],
    ['execution grant', (v) => { v.grants.executionAuthorized = true; }],
    ['effect grant', (v) => { v.grants.effectAuthorized = true; }],
    ['empty slot set', (v) => { v.slots = []; }],
    ['duplicate slot', (v) => { v.slots.push({ ...v.slots[0] }); }],
  ]) {
    assert.equal(snapshotValid(mutate(agsSnapshot(), edit)), false, `AGS ${name}`);
    assert.equal(snapshotValid(mutate(vmSnapshot(), edit)), false, `VM ${name}`);
  }
});

test('R17 keeps the two producers separate and never promotes A2 same-user signatures', () => {
  assert.equal(snapshotValid(mutate(agsSnapshot(), (v) => { v.approval.origin = 'vm-core-goal-authorization'; })), false);
  assert.equal(snapshotValid(mutate(vmSnapshot(), (v) => { v.approval.origin = 'ags-workflow-approval-record'; })), false);
  assert.equal(snapshotValid(mutate(vmSnapshot(), (v) => { delete v.scope.projectId; })), false);
  assert.equal(snapshotValid(mutate(vmSnapshot(), (v) => {
    v.producer.principal = { profileId: 'flowmarshal-same-user-v1', protectedPrincipal: false }; })), false);
  assert.equal(snapshotValid(mutate(agsSnapshot(), (v) => { v.producer.principal.protectedPrincipal = true; })), false);
  assert.equal(snapshotValid(mutate(agsSnapshot(), (v) => {
    v.producer.principal = { profileId: 'vm-protected-v1', protectedPrincipal: true }; })), false, 'AGS claims VM principal');
  assert.equal(snapshotValid(mutate(agsSnapshot(), (v) => {
    v.producer.principal = { profileId: 'flowmarshal-same-user-v1', protectedPrincipal: false }; })), false, 'AGS claims A2');
  assert.equal(principalValid({ profileId: 'flowmarshal-same-user-v1', protectedPrincipal: true }), false);
  assert.equal(principalValid({ profileId: 'flowmarshal-same-user-v1', protectedPrincipal: false }), true);
});

test('R17 reservations move monotonically and unknown never becomes success or cancellation', () => {
  const base = { reservationId: 'res-1', slotId: slot.slotId, snapshotDigest: d('c'), sourceRevision: 7, state: 'pending', identity: null };
  const identity = { actorId: 'actor-1', host: 'claude-code', sessionId: 'session-1', verifiedBy: 'ags-server-session-binding' };
  assert.equal(reservationValid(base), true);
  const unslotted = { ...base }; delete unslotted.slotId;
  assert.equal(reservationValid(unslotted), false, 'reservation must name its slot');
  assert.equal(reservationValid({ ...base, identity }), false, 'pending carries no session');
  assert.equal(reservationValid({ ...base, state: 'bound', identity }), true);
  assert.equal(reservationValid({ ...base, state: 'admitted', identity: null }), false);
  assert.equal(reservationValid({ ...base, state: 'bound', identity: { ...identity, verifiedBy: 'caller-report' } }), false);
  assert.equal(reservationValid({ ...base, state: 'closed' }), false, 'closed needs a reason');
  assert.equal(reservationValid({ ...base, state: 'unknown', closeReason: 'revoked-before-effect' }), false);
  assert.deepEqual(transitions, { pending: ['bound', 'closed', 'unknown'], bound: ['admitted', 'closed', 'unknown'],
    admitted: ['closed', 'unknown'], unknown: ['closed'], closed: [] });
  for (const [from, to] of Object.entries(transitions)) assert.equal(to.includes(from), false, `${from} does not loop`);
  assert.equal(Object.values(transitions).some((to) => to.includes('pending')), false);
});

test('R17 effect start denies without invoking and records every forbidden source', () => {
  const start = { decision: 'start', reservationId: 'res-1', slotId: slot.slotId, recheckedSourceRevision: 7, invokeCount: 1 };
  assert.equal(effectValid(start), true);
  assert.equal(effectValid({ ...start, invokeCount: 0 }), false, 'start records one invoke');
  const bare = { ...start }; delete bare.invokeCount; delete bare.slotId;
  assert.equal(effectValid({ ...bare, slotId: slot.slotId, decision: 'unknown' }), true);
  assert.equal(effectValid({ ...start, decision: 'unknown' }), false, 'unknown does not assert invokes');
  assert.equal(effectValid({ ...bare, decision: 'unknown' }), false, 'decision must name its slot');
  for (const denyReason of ['caller-supplied-source', 'unknown-slot', 'stale-revision', 'revoked',
    'reservation-not-admitted', 'identity-unverified', 'same-user-not-protected', 'source-unqualified']) {
    assert.equal(effectValid({ ...start, decision: 'deny', invokeCount: 0, denyReason }), true, denyReason);
    assert.equal(effectValid({ ...start, decision: 'deny', invokeCount: 1, denyReason }), false, `${denyReason} invoked`);
  }
  assert.equal(effectValid({ ...start, decision: 'deny', invokeCount: 0 }), false, 'deny needs a reason');
  assert.equal(effectValid({ ...start, denyReason: 'revoked' }), false);
});

test('R17 freeze qualifies only integrated rows and keeps pending rows unusable', () => {
  assert.equal(freezeValid(freeze), true, JSON.stringify(freezeValid.errors));
  const pending = rows.findIndex((row) => row.rowId === 'vm-r16d-dispatch-claim');
  for (const [name, edit] of [
    ['pending row used as source', (v) => { v.rows[pending].usableAs = ['contract-freeze-input']; }],
    ['pending row claimed implemented', (v) => { v.rows[pending].implementationState = 'IMPLEMENTED_INTEGRATED'; }],
    ['runtime qualification claimed', (v) => { v.rows[0].runtimeQualification = 'QUALIFIED'; }],
    ['qualified VM row without integration SHA', (v) => { delete v.rows[3].integration; }],
    ['AGS row claimed integrated', (v) => { v.rows[0].integration = { repository: 'AGS', ref: 'main', sha: 'f'.repeat(40) }; }],
    ['failed verdict requests completion', (v) => { v.verdict = 'CONTRACT_FAILED'; }],
    ['AGS core tied to VM runtime', (v) => { v.agsCoreIndependentOfVmRuntime = false; }],
    ['R16-d promoted with fake SHA', (v) => { Object.assign(v.rows[pending], { qualification: 'QUALIFIED',
      implementationState: 'IMPLEMENTED_INTEGRATED', usableAs: ['contract-freeze-input'],
      integration: { repository: 'FM', ref: 'main', sha: 'f'.repeat(40) } }); }],
    ['pending row with integration SHA', (v) => { v.rows[pending].integration = { repository: 'FM', ref: 'main', sha: 'f'.repeat(40) }; }],
    ['mismatched repository and ref', (v) => { v.rows[3].integration.ref = 'codex/v260-semantic-decision-layer'; }],
    ['AGS row naming a VM task', (v) => { v.rows[0].tasks = ['R16-d']; }],
    ['qualified VM row naming an unlisted task', (v) => { v.rows[3].tasks = ['R16-x']; }],
    ['freeze without R16-d row', (v) => { v.rows.splice(pending, 1); }],
    ['freeze without R16-f row', (v) => { v.rows = v.rows.filter((row) => !row.tasks.includes('R16-f')); }],
  ]) assert.equal(freezeValid(mutate(freeze, edit)), false, name);
  assert.equal(freezeValid({ ...freeze, verdict: 'CONTRACT_FAILED', progressRequest: 'BLOCKED' }), true);
  assert.equal(freezeValid({ ...freeze, verdict: 'NOT_RUN', progressRequest: 'NOT_RUN' }), true);
});

test('R17 document table matches the frozen rows', () => {
  assert.equal(new Set(rows.map((row) => row.rowId)).size, rows.length, 'row IDs are unique');
  for (const row of rows) {
    const line = doc.split('\n').find((text) => text.startsWith(`| \`${row.rowId}\``));
    assert.ok(line, row.rowId);
    const cells = line.split('|').map((cell) => cell.trim());
    assert.equal(cells[2].replaceAll('*', ''), row.qualification, row.rowId);
    assert.equal(cells[4], row.implementationState, row.rowId);
    if (row.integration) assert.ok(cells[3].includes(row.integration.sha), row.rowId);
    else assert.equal(cells[3], '—', row.rowId);
    if (row.qualification === 'UNQUALIFIED_PENDING') assert.deepEqual(cells.slice(5, 9), ['미확정', '미확정', '미확정', '미확정']);
  }
  assert.match(doc, /R17-R16-REVALIDATION/u);
  assert.match(doc, /VM approved-slot 효과 시작을 \*\*해제하지 않는다\*\*/u);
  assert.match(doc, /runtimeQualification=NOT_CLAIMED/u);
});
