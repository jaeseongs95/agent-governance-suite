import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { test } from 'vitest';

import { CHECKPOINT_DELTA_MAX_BYTES } from '../../../contracts/types.ts';
import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { verifyInlineCheckpointDelta, verifyTransportReadback } from '../../../mcp-server/src/artifacts/transport-verification.ts';

function reference(bytes, namespace = 'task') {
  return { schemaVersion: '1.0.0', namespace, id: 'checkpoint-1',
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    hashDomain: 'raw-bytes', size: bytes.byteLength, mediaType: 'application/octet-stream' };
}

function readback(bytes, ref = reference(bytes), encoding = 'identity', raw) {
  return { ref, bytes, expectedNamespace: 'task', encoding, ...(raw ? { raw } : {}) };
}

function rawClaim(bytes) {
  return { size: bytes.byteLength, digest: reference(bytes).digest };
}

function spies() {
  const calls = { decode: 0, decompress: 0 };
  const codec = {
    decode(value) { calls.decode += 1; return Buffer.from(value).toString('utf8'); },
    decompress(value) { calls.decompress += 1; return gunzipSync(value); },
  };
  return { calls, codec };
}

test('A09 verifies raw and compressed bytes before decode or decompress', () => {
  const raw = Buffer.from('an immutable full checkpoint');
  const plain = spies();
  assert.equal(verifyTransportReadback(readback(raw), plain.codec), raw.toString('utf8'));
  assert.deepEqual(plain.calls, { decode: 1, decompress: 0 });

  const compressed = gzipSync(raw);
  const zipped = spies();
  assert.equal(verifyTransportReadback(readback(compressed, reference(compressed), 'gzip', rawClaim(raw)), zipped.codec),
    raw.toString('utf8'));
  assert.deepEqual(zipped.calls, { decode: 1, decompress: 1 });
});

test('A09 rejects corrupt bytes, length, domain and namespace before either callback', () => {
  const bytes = gzipSync(Buffer.from('checkpoint'));
  const ref = reference(bytes);
  for (const changed of [
    { bytes: Buffer.from('corrupt') },
    { bytes: Buffer.from(bytes.map((value, index) => index === 0 ? value ^ 1 : value)) },
    { ref: { ...ref, size: ref.size + 1 } },
    { ref: { ...ref, hashDomain: 'canonical-json' } },
    { ref: { ...ref, namespace: 'workspace' } },
    { expectedNamespace: 'workspace' },
  ]) {
    const { calls, codec } = spies();
    assert.throws(() => verifyTransportReadback({ ...readback(bytes, ref, 'gzip', rawClaim(Buffer.from('checkpoint'))), ...changed }, codec));
    assert.deepEqual(calls, { decode: 0, decompress: 0 });
  }
});

test('A09 checks uncompressed length and hash before decode', () => {
  const raw = Buffer.from('checkpoint');
  const compressed = gzipSync(raw);
  for (const claim of [
    { ...rawClaim(raw), size: raw.length + 1 },
    { ...rawClaim(raw), digest: reference(Buffer.from('different')).digest },
  ]) {
    const { calls, codec } = spies();
    assert.throws(() => verifyTransportReadback(readback(compressed, reference(compressed), 'gzip', claim), codec),
      { code: 'INTEGRITY_FAILED' });
    assert.deepEqual(calls, { decode: 0, decompress: 1 });
  }
  const { calls, codec } = spies();
  assert.throws(() => verifyTransportReadback(readback(compressed, reference(compressed), 'gzip'), codec),
    { code: 'INVALID_INPUT' });
  assert.deepEqual(calls, { decode: 0, decompress: 0 });
});

test('A09 has no text, Base64 or manual chunk reassembly input', () => {
  const bytes = Buffer.from('a large payload from an object reference');
  const ref = reference(bytes);
  for (const supplied of [bytes.toString('utf8'), bytes.toString('base64'),
    [bytes.subarray(0, 5), bytes.subarray(5)], ['a large ', 'payload']]) {
    const { calls, codec } = spies();
    assert.throws(() => verifyTransportReadback(readback(supplied, ref), codec), { code: 'INVALID_INPUT' });
    assert.deepEqual(calls, { decode: 0, decompress: 0 });
  }
  const { calls, codec } = spies();
  assert.throws(() => verifyTransportReadback({ ...readback(bytes), encoding: 'gzip' }, { decode: codec.decode }),
    { code: 'INVALID_INPUT' });
  assert.deepEqual(calls, { decode: 0, decompress: 0 });
});

test('A09 accepts only one bounded structured inline delta', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const small = { schemaVersion: '1.0.0', taskId: 'task-1', revision: 1,
    receiver: { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' },
    contextGeneration: 0, sequence: 1, baseCheckpointDigest: digest,
    targetCheckpointDigest: digest, operations: [{ op: 'set', path: '/status', value: 'paused' }] };
  assert.deepEqual(verifyInlineCheckpointDelta(small), small);
  for (const supplied of [JSON.stringify(small), [small], [JSON.stringify(small)], null]) {
    assert.throws(() => verifyInlineCheckpointDelta(supplied), { code: 'INVALID_INPUT' });
  }
  const large = structuredClone(small);
  large.operations = [{ op: 'set', path: '/core/objective', value: '가'.repeat(CHECKPOINT_DELTA_MAX_BYTES) }];
  assert.ok(Buffer.byteLength(canonicalJson(large), 'utf8') > CHECKPOINT_DELTA_MAX_BYTES);
  assert.throws(() => verifyInlineCheckpointDelta(large), { code: 'INVALID_INPUT' });
});
