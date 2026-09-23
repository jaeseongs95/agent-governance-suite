import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';
import {
  ContractValidator, artifactRefToCheckpointEvidence, checkpointEvidenceToArtifactRef,
  sameArtifactRefIdentity, verifyArtifactRefContent,
} from '../../../mcp-server/src/schema-validator.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';

const validator = new ContractValidator();
const digestBytes = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

test('A01 converts legacy canonical JSON evidence without promoting locator or verified to authority', () => {
  const content = { z: 1, a: ['evidence'] };
  const evidence = { artifactId: 'check-1', locator: 'tests/context-continuity', digest: convergenceDigest(content), verified: true };
  const ref = checkpointEvidenceToArtifactRef(validator, evidence, content, 'canonical-json', 'application/json');
  assert.deepEqual(ref, {
    schemaVersion: '1.0.0', namespace: 'checkpoint-evidence', id: 'check-1', digest: evidence.digest,
    hashDomain: 'canonical-json', size: Buffer.byteLength('{"a":["evidence"],"z":1}'), mediaType: 'application/json',
  });
  assert.equal(Object.hasOwn(ref, 'locator'), false);
  assert.equal(Object.hasOwn(ref, 'verified'), false);
  assert.deepEqual(artifactRefToCheckpointEvidence(validator, ref, evidence), evidence);
  assert.throws(() => validator.artifactRef({ ...ref, locator: 'https://example.invalid/a' }));
  assert.throws(() => validator.artifactRef({ ...ref, url: 'https://example.invalid/a' }));
  assert.throws(() => validator.artifactRef({ ...ref, verified: true }));
  assert.throws(() => validator.artifactRef({ ...ref, canRead: true }));
});

test('A01 checks bytes, size, domain, namespace, and scoped identity', () => {
  const bytes = Buffer.from('raw evidence');
  const evidence = { artifactId: 'raw-1', locator: 'evidence/raw-1', digest: digestBytes(bytes), verified: false };
  const ref = checkpointEvidenceToArtifactRef(validator, evidence, bytes, 'raw-bytes', 'application/octet-stream');
  assert.deepEqual(artifactRefToCheckpointEvidence(validator, ref, evidence), evidence);
  assert.throws(() => checkpointEvidenceToArtifactRef(validator, evidence, bytes, 'canonical-json', 'application/json'));
  assert.throws(() => checkpointEvidenceToArtifactRef(validator, evidence, 'raw evidence', 'raw-bytes', 'text/plain'));
  assert.throws(() => verifyArtifactRefContent(validator, { ...ref, size: ref.size + 1 }, bytes));
  assert.throws(() => verifyArtifactRefContent(validator, { ...ref, digest: convergenceDigest('raw evidence'), hashDomain: 'canonical-json' }, bytes));
  assert.throws(() => validator.artifactRef({ ...ref, namespace: 'external' }));
  assert.throws(() => validator.artifactRef({ ...ref, id: 'https://example.invalid/a' }));
  assert.equal(sameArtifactRefIdentity(ref, { ...ref, namespace: 'task' }), false);
  assert.equal(sameArtifactRefIdentity(ref, { ...ref, hashDomain: 'canonical-json' }), false);
  assert.throws(() => artifactRefToCheckpointEvidence(validator, { ...ref, namespace: 'task' }, evidence));
});
