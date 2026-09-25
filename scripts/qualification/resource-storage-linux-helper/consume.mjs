#!/usr/bin/env node
// AGS consumption boundary for the B14-n-l Linux storage identity helper.
// The helper bytes and source are measured against manifest.json before every
// run. Callers cannot supply an expected identity: identities only come from
// helper observations of an open handle and are compared with each other.
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
const ALLOWED_OPTIONS = new Set(['helperDirectory']);
const defaultDirectory = fileURLToPath(new URL('.', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const unknown = (code) => ({ status: 'UNKNOWN', qualification: 'FIXTURE_ONLY', code });

function measuredHelper(directory) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  } catch {
    return { error: 'HELPER_MANIFEST_INVALID' };
  }
  if (manifest?.schema !== 'AgsLinuxStorageHelperManifest.v1' ||
      !/^[0-9a-f]{64}$/.test(manifest.sourceSha256 ?? '') ||
      !/^[0-9a-f]{64}$/.test(manifest.artifactSha256 ?? '')) {
    return { error: 'HELPER_MANIFEST_INVALID' };
  }
  try {
    if (sha256(readFileSync(join(directory, manifest.source))) !== manifest.sourceSha256 ||
        sha256(readFileSync(join(directory, manifest.artifact))) !== manifest.artifactSha256) {
      return { error: 'HELPER_DIGEST_MISMATCH' };
    }
  } catch {
    return { error: 'HELPER_DIGEST_MISMATCH' };
  }
  return { artifact: join(directory, manifest.artifact), manifest };
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
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.has(key)) throw new TypeError(`CALLER_FIELD_REJECTED: ${key}`);
  }
  if (process.platform !== 'linux') return unknown('UNSUPPORTED_PLATFORM');
  if (typeof path !== 'string' || !isAbsolute(path)) return unknown('INVALID_PATH');
  const helper = measuredHelper(options.helperDirectory ?? defaultDirectory);
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
    return exitOk && validObservation(body) ? body : unknown('HELPER_OUTPUT_INVALID');
  }
  if (FAILURE_STATUSES.has(body.status) && exitOk && typeof body.code === 'string') return body;
  return unknown('HELPER_OUTPUT_INVALID');
}

// Both arguments must be helper observations; strings or caller JSON never match.
export function sameStorageIdentity(left, right) {
  return [left, right].every((body) => body?.schema === SCHEMA && validObservation(body)) &&
    left.identity === right.identity;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = observeLinuxStorageIdentity(process.argv[2]);
  console.log(JSON.stringify(result));
  process.exit(EXIT_BY_STATUS[result.status] ?? 2);
}
