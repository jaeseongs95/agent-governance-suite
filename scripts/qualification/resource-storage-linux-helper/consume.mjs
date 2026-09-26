#!/usr/bin/env node
// AGS consumption boundary for the B14-n-l Linux storage identity helper.
// The helper bytes and source are measured against manifest.json before every
// run. Callers cannot supply an expected identity: identities only come from
// helper observations of an open handle and are compared with each other.
// The helper location is fixed to this module's directory and the expected
// digests are pinned here as well as in manifest.json; callers cannot move it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA = 'AgsLinuxStorageIdentity.v1';
const OBSERVATION_STATUSES = new Set(['OBSERVED', 'BLOCKED_ALIAS']);
const FAILURE_STATUSES = new Set([
  'UNKNOWN', 'BLOCKED_SYMLINK', 'BLOCKED_PATH', 'BLOCKED_PATH_CHANGED', 'BLOCKED_NOT_REGULAR',
  'BLOCKED_NO_GENERATION', 'UNSUPPORTED_FILESYSTEM',
]);
const EXIT_BY_STATUS = { OBSERVED: 0, BLOCKED_ALIAS: 2, UNKNOWN: 1 };
export const PINNED_SOURCE_SHA256 = 'bf69234c256bd98764cddadfbe58a247f72dcab671d08330640a011bf53986e0';
export const PINNED_ARTIFACT_SHA256 = 'a4ec62796354f92433a6f5f3dd793475d4027bb9878dbcc7adbc82c17663efe0';
const HELPER_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const SOURCE = 'resource-storage-linux.c';
const ARTIFACT = 'resource-storage-linux';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
// Observations this module returned in this process. Membership cannot be forged
// by callers: copies, JSON, structuredClone and Proxy objects are not members.
const issuedObservations = new WeakSet();
const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};
const unknown = (code) => deepFreeze({ status: 'UNKNOWN', qualification: 'FIXTURE_ONLY', code });

function measuredHelper() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(HELPER_DIRECTORY, 'manifest.json'), 'utf8'));
  } catch {
    return { error: 'HELPER_MANIFEST_INVALID' };
  }
  if (manifest?.schema !== 'AgsLinuxStorageHelperManifest.v1' || manifest.source !== SOURCE ||
      manifest.artifact !== ARTIFACT) {
    return { error: 'HELPER_MANIFEST_INVALID' };
  }
  if (manifest.sourceSha256 !== PINNED_SOURCE_SHA256 || manifest.artifactSha256 !== PINNED_ARTIFACT_SHA256) {
    return { error: 'HELPER_DIGEST_MISMATCH' };
  }
  try {
    if (sha256(readFileSync(join(HELPER_DIRECTORY, SOURCE))) !== PINNED_SOURCE_SHA256 ||
        sha256(readFileSync(join(HELPER_DIRECTORY, ARTIFACT))) !== PINNED_ARTIFACT_SHA256) {
      return { error: 'HELPER_DIGEST_MISMATCH' };
    }
  } catch {
    return { error: 'HELPER_DIGEST_MISMATCH' };
  }
  return { artifact: join(HELPER_DIRECTORY, ARTIFACT) };
}

function validObservation(body) {
  const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
  if (!OBSERVATION_STATUSES.has(body.status) || !hex(body.fsid, 16) || !hex(body.inode, 16) ||
      !hex(body.generation, 8) || body.generation === '00000000' || !Number.isInteger(body.handleType) ||
      !Number.isInteger(body.handleBytes) || !hex(body.handle, body.handleBytes * 2) ||
      !Number.isInteger(body.linkCount)) {
    return false;
  }
  const expected = `${body.fsid}:${body.inode}:${body.handleType.toString(16).padStart(8, '0')}:${body.handle}`;
  return body.identity === expected && (body.status === 'OBSERVED') === (body.linkCount === 1);
}

export function observeLinuxStorageIdentity(path, options = {}) {
  // No caller option is accepted: not a helper location, manifest or expected identity.
  if (options === null || typeof options !== 'object' || Reflect.ownKeys(options).length > 0) {
    throw new TypeError(`CALLER_FIELD_REJECTED: ${String(Reflect.ownKeys(options ?? {})[0] ?? typeof options)}`);
  }
  if (process.platform !== 'linux') return unknown('UNSUPPORTED_PLATFORM');
  if (typeof path !== 'string' || !isAbsolute(path)) return unknown('INVALID_PATH');
  const helper = measuredHelper();
  if (helper.error) return unknown(helper.error);
  const child = spawnSync(helper.artifact, [path], { cwd: '/', encoding: 'utf8', env: {}, timeout: 10_000 });
  if (child.error || child.signal) return unknown('HELPER_EXECUTION_FAILED');
  const lines = child.stdout.split('\n').filter(Boolean);
  if (lines.length !== 1 || child.stderr !== '') return unknown('HELPER_OUTPUT_INVALID');
  let body;
  try {
    body = JSON.parse(lines[0]);
  } catch {
    return unknown('HELPER_OUTPUT_INVALID');
  }
  if (body?.schema !== SCHEMA || body.qualification !== 'FIXTURE_ONLY' || 'mode' in body) {
    return unknown('HELPER_OUTPUT_INVALID');
  }
  const exitOk = (EXIT_BY_STATUS[body.status] ?? 2) === child.status;
  if (OBSERVATION_STATUSES.has(body.status)) {
    if (!exitOk || !validObservation(body)) return unknown('HELPER_OUTPUT_INVALID');
    issuedObservations.add(deepFreeze(body));
    return body;
  }
  if (FAILURE_STATUSES.has(body.status) && exitOk && typeof body.code === 'string') return deepFreeze(body);
  return unknown('HELPER_OUTPUT_INVALID');
}

// Both arguments must be frozen OBSERVED observations (link count 1) issued by
// observeLinuxStorageIdentity in this process; aliases, BLOCKED_* results,
// strings, copies and caller JSON never match.
export function sameStorageIdentity(left, right) {
  return [left, right].every((body) => body !== null && typeof body === 'object' &&
    issuedObservations.has(body) && Object.isFrozen(body) && body.status === 'OBSERVED' &&
    body.linkCount === 1 && validObservation(body)) && left.identity === right.identity;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = observeLinuxStorageIdentity(process.argv[2]);
  console.log(JSON.stringify(result));
  process.exit(EXIT_BY_STATUS[result.status] ?? 2);
}
