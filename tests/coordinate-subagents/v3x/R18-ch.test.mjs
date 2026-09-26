import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';

const read = (path) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const schema = JSON.parse(read('contracts/user-approval-channel.v1.schema.json'));
const survey = JSON.parse(read('docs/implementation-3x/evidence/R18-ch-approval-channel-survey.json'));
const doc = read('docs/implementation-3x/user-approval-channel.ko.md');
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false }).addSchema(schema);
const proofValid = ajv.getSchema(schema.$id);
const freezeValid = ajv.getSchema(`${schema.$id}#/$defs/contractFreeze`);

const d = (c) => `sha256:${c.repeat(64)}`;
function proof() {
  return { schemaVersion: '1.0.0', kind: 'ags-user-approval-proof',
    statement: { schemaVersion: '1.0.0', kind: 'ags-user-approval-statement', originKind: 'out-of-band-signed-approver',
      decision: 'approve',
      binding: { runId: 'run-1', taskId: 'task-1', stageId: 'stage-1', assignmentId: 'assign-1', approvalRevision: 3, approvalDigest: d('a') },
      challenge: { issuedBy: 'ags-server', nonce: 'A'.repeat(43), issuedAt: '2026-09-26T13:00:00Z', expiresAt: '2026-09-26T13:05:00Z' },
      approver: { keyId: d('b'), enrollmentRevision: 1 },
      displayedFields: ['runId', 'taskId', 'stageId', 'assignmentId', 'approvalRevision', 'approvalDigest', 'decision'] },
    proof: { format: 'ed25519-jcs-v1', keyId: d('b'), signature: 'S'.repeat(86) } };
}
function mutate(edit) { const value = proof(); edit(value); return value; }

const nonAuthoritativeKinds = ['user-turn', 'user-prompt-submit-hook', 'permission-request-hook', 'elicitation-hook',
  'claude-code-elicitation', 'codex-elicitation', 'ask-user-question-relay', 'model-summary', 'peer-message', 'caller-json',
  'needs-approval-state', 'user-approval-ref', 'workspace-file', 'ack', 'stop-signal', 'pid', 'process-name', 'turn-hash',
  'host-attestation', 'windows-user-consent-verifier', 'platform-user-verified-key', 'local-file-key'];

test('R18-ch accepts only a well-formed out-of-band signed approval proof', () => {
  assert.equal(proofValid(proof()), true, JSON.stringify(proofValid.errors));
});

test('R18-ch rejects non-authoritative origin kinds', () => {
  for (const kind of nonAuthoritativeKinds) {
    assert.equal(proofValid(mutate((v) => { v.statement.originKind = kind; })), false, kind);
  }
});

test('R18-ch rejects approvals missing a binding field', () => {
  for (const field of ['runId', 'taskId', 'stageId', 'assignmentId', 'approvalRevision', 'approvalDigest']) {
    assert.equal(proofValid(mutate((v) => { delete v.statement.binding[field]; })), false, field);
  }
  for (const part of ['binding', 'challenge', 'approver', 'displayedFields', 'decision']) {
    assert.equal(proofValid(mutate((v) => { delete v.statement[part]; })), false, part);
  }
  assert.equal(proofValid(mutate((v) => { delete v.proof; })), false, 'proof');
  assert.equal(proofValid(mutate((v) => { v.statement.displayedFields = ['runId', 'taskId']; })), false, 'displayedFields');
});

test('R18-ch rejects proof format violations and caller-supplied authority fields', () => {
  const cases = {
    signatureLength: (v) => { v.proof.signature = 'S'.repeat(85); },
    signatureCharset: (v) => { v.proof.signature = `${'S'.repeat(85)}=`; },
    proofFormat: (v) => { v.proof.format = 'hmac-sha256'; },
    keyIdFormat: (v) => { v.proof.keyId = 'key-1'; },
    digestFormat: (v) => { v.statement.binding.approvalDigest = 'a'.repeat(64); },
    revision: (v) => { v.statement.binding.approvalRevision = -1; },
    revisionMax: (v) => { v.statement.binding.approvalRevision = 9007199254740992; },
    idPattern: (v) => { v.statement.binding.runId = ' run 1'; },
    nonceMissing: (v) => { delete v.statement.challenge.nonce; },
    nonceFormat: (v) => { v.statement.challenge.nonce = 'short'; },
    challengeIssuer: (v) => { v.statement.challenge.issuedBy = 'caller'; },
    decision: (v) => { v.statement.decision = 'approved=true'; },
    approvedFlag: (v) => { v.statement.approved = true; },
    approvalRefs: (v) => { v.statement.userApprovalRefs = ['ref-1']; },
    extraProofField: (v) => { v.proof.hookVerdict = 'allow'; },
  };
  for (const [name, edit] of Object.entries(cases)) assert.equal(proofValid(mutate(edit)), false, name);
});

test('R18-ch rejects missing required fields, unknown fields and wrong constants at every level', () => {
  const levels = { top: (v) => v, statement: (v) => v.statement, binding: (v) => v.statement.binding,
    challenge: (v) => v.statement.challenge, approver: (v) => v.statement.approver, proof: (v) => v.proof };
  for (const [level, at] of Object.entries(levels)) {
    for (const key of Object.keys(at(proof()))) {
      assert.equal(proofValid(mutate((v) => { delete at(v)[key]; })), false, `${level}.${key} missing`);
    }
    assert.equal(proofValid(mutate((v) => { at(v).extra = true; })), false, `${level} extra field`);
  }
  const cases = {
    topVersion: (v) => { v.schemaVersion = '2.0.0'; },
    topKind: (v) => { v.kind = 'ags-user-approval'; },
    statementVersion: (v) => { v.statement.schemaVersion = '2.0.0'; },
    statementKind: (v) => { v.statement.kind = 'approval'; },
    nonceLong: (v) => { v.statement.challenge.nonce = 'A'.repeat(44); },
    approverKeyId: (v) => { v.statement.approver.keyId = 'key-1'; },
    idTooLong: (v) => { v.statement.binding.taskId = 'a'.repeat(201); },
    displayedDuplicates: (v) => { v.statement.displayedFields = Array(7).fill('runId'); },
    displayedUnknown: (v) => { v.statement.displayedFields[6] = 'note'; },
    revisionFraction: (v) => { v.statement.binding.approvalRevision = 1.5; },
    digestUpper: (v) => { v.statement.binding.approvalDigest = `sha256:${'A'.repeat(64)}`; },
    timestamp: (v) => { v.statement.challenge.issuedAt = 'yesterday'; },
    enrollmentRevision: (v) => { v.statement.approver.enrollmentRevision = 0; },
  };
  for (const [name, edit] of Object.entries(cases)) assert.equal(proofValid(mutate(edit)), false, name);
});

test('R18-ch contract freeze is closed and FROZEN needs both guard conditions', () => {
  const freeze = survey.contractFreeze;
  const edit = (change) => { const value = structuredClone(freeze); change(value); return value; };
  for (const key of Object.keys(freeze)) {
    assert.equal(freezeValid(edit((f) => { delete f[key]; })), false, `${key} missing`);
  }
  for (const key of Object.keys(freeze.enforcedBy)) {
    assert.equal(freezeValid(edit((f) => { delete f.enforcedBy[key]; })), false, `enforcedBy.${key} missing`);
  }
  const cases = {
    extra: (f) => { f.extra = true; },
    enforcedByExtra: (f) => { f.enforcedBy.extra = { task: 'R18-a', point: 'x' }; },
    enforcementExtra: (f) => { f.enforcedBy.replay.extra = true; },
    enforcementTaskEmpty: (f) => { f.enforcedBy.replay.task = ''; },
    candidateExtra: (f) => { f.candidates[0].extra = true; },
    candidateName: (f) => { f.candidates[0].candidate = 'other-app'; },
    determination: (f) => { f.candidates[0].determination = 'PASS'; },
    verdict: (f) => { f.verdict = 'PASS'; },
    task: (f) => { f.task = 'R18-a'; },
  };
  for (const [name, change] of Object.entries(cases)) assert.equal(freezeValid(edit(change)), false, name);
  const satisfies = (f) => { f.candidates[0].determination = 'SATISFIES_ALL_PROPERTIES'; };
  const anchored = (f) => { f.enforcedBy.trustAnchorTamper.task = 'PROTECTED-VERIFIER'; };
  const frozen = (f) => { f.verdict = 'USER_APPROVAL_CHANNEL_FROZEN'; };
  assert.equal(freezeValid(edit((f) => { frozen(f); anchored(f); })), false, 'FROZEN without a satisfying candidate');
  assert.equal(freezeValid(edit((f) => { frozen(f); satisfies(f); })), false, 'FROZEN with unassigned trust anchor');
  assert.equal(freezeValid(edit((f) => { frozen(f); satisfies(f); anchored(f); })), true, JSON.stringify(freezeValid.errors));
});

test('R18-ch schema PASS is not rejection evidence for state or crypto conditions', () => {
  // A well-formed forged signature or a replayed/cross-run/revoked proof is schema-valid; R18-a intake must reject it.
  assert.equal(proofValid(mutate((v) => { v.proof.signature = 'F'.repeat(86); })), true);
  const conditions = ['forgedSignature', 'crossRunReuse', 'replay', 'useAfterRevocation', 'expiredChallenge',
    'unenrolledOrRevokedKey', 'hookModelPeerEvent', 'denyRecordedAsApproval', 'trustAnchorTamper'];
  const freeze = survey.contractFreeze;
  assert.equal(freezeValid(freeze), true, JSON.stringify(freezeValid.errors));
  assert.deepEqual(Object.keys(freeze.enforcedBy).sort(), [...conditions].sort());
  for (const c of conditions) assert.match(doc, new RegExp(`\`${c}\``), c);
  assert.equal(freezeValid({ ...freeze, schemaFixtureRejectionEvidenceFor: ['replay'] }), false);
  assert.equal(freezeValid({ ...freeze, runtimeQualification: 'QUALIFIED' }), false);
});

test('R18-ch verdict is BLOCKED_CONTRACT while no surveyed candidate satisfies every property', () => {
  const freeze = survey.contractFreeze;
  const satisfying = freeze.candidates.filter((c) => c.determination === 'SATISFIES_ALL_PROPERTIES');
  assert.equal(satisfying.length, 0);
  assert.equal(freeze.verdict, 'BLOCKED_CONTRACT');
  assert.equal(freezeValid({ ...freeze, verdict: 'USER_APPROVAL_CHANNEL_FROZEN' }), false);
  const names = freeze.candidates.map((c) => c.candidate).sort();
  assert.deepEqual(names, ['claude-code-elicitation', 'codex-elicitation', 'local-user-signing-key',
    'os-user-verification', 'out-of-band-signed-approver-app']);
  assert.deepEqual(survey.candidates.map((c) => c.candidate).sort(), names);
});

test('R18-ch contract names every excluded signal', () => {
  for (const term of ['PID', '프로세스 이름', 'turn hash', 'UserPromptSubmit', 'PermissionRequest', 'Elicitation hook', 'ACK',
    'Stop', 'peer 메시지', '모델이 중계하거나 요약한 사용자 응답', 'caller JSON', 'needs-approval', 'userApprovalRefs', 'workspace 파일']) {
    assert.ok(doc.includes(term), term);
  }
});
