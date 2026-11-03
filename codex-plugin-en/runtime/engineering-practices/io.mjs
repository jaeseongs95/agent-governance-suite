// Adapted from the user-provided AGS CS Engineering v0.1.0 (MIT).
import { createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { hostText } from '../i18n.mjs';

// The message is a catalog key and params, rendered in the host locale when the error is raised.
export class PracticeError extends Error {
  constructor(code, messageKey, params = {}, details = null, options = {}) { super(hostText(messageKey, params), options); this.name = 'PracticeError'; this.code = code; this.messageKey = messageKey; this.params = params; this.details = details; }
}
export function requireCondition(condition, code, messageKey, params = {}, details = null) {
  if (!condition) throw new PracticeError(code, messageKey, params, details);
}
export function canonicalJson(value, depth = 0) {
  requireCondition(depth <= 64, 'INVALID_INPUT', 'practices.io.jsonNestingExceeds64');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k], depth + 1)).join(',') + '}';
  }
  throw new PracticeError('INVALID_INPUT', 'practices.io.onlyFiniteJsonValuesAndPlain');
}
export const hashBytes = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
export const hashJson = value => hashBytes(Buffer.from(canonicalJson(value), 'utf8'));
export function uniqueBy(items, key, label) {
  const map = new Map();
  for (const item of items) {
    requireCondition(!map.has(item[key]), 'INVALID_INPUT', 'practices.io.duplicateEntry', { label, value: String(item[key]) });
    map.set(item[key], item);
  }
  return map;
}
export function sameSet(a, b) { const left = new Set(a), right = new Set(b); return a.length === b.length && left.size === a.length && right.size === b.length && [...left].every(v => right.has(v)); }
export function portablePath(relative) {
  requireCondition(typeof relative === 'string' && relative.length > 0 && relative.length <= 4096, 'INVALID_INPUT', 'practices.io.aBoundedRelativePathIsRequired');
  requireCondition(!/[\\:]/u.test(relative) && [...relative].every(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) && !relative.startsWith('/'), 'INVALID_INPUT', 'practices.io.absoluteDriveBackslashControlAndStream');
  const parts = relative.split('/');
  requireCondition(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/u.test(p) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p)), 'INVALID_INPUT', 'practices.io.unsafePathComponent');
  return parts;
}
// The artifact root must be private/trusted. This is not an OS sandbox against
// an adversary concurrently replacing ancestor directories or hard links.
export function readBoundedFile(root, relative, maxBytes = 1024 * 1024) {
  const parts = portablePath(relative);
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, 'INVALID_INPUT', 'practices.io.invalidFileLimit');
  const resolvedRoot = path.resolve(root);
  const rootStat = lstatSync(resolvedRoot);
  requireCondition(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'INVALID_INPUT', 'practices.io.artifactRootMustBeAReal');
  const realRoot = realpathSync(resolvedRoot);
  let target = realRoot;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    const info = lstatSync(target);
    requireCondition(!info.isSymbolicLink(), 'INVALID_INPUT', 'practices.io.symlinksAreNotAllowedInArtifact');
    requireCondition(i === parts.length - 1 ? info.isFile() : info.isDirectory(), 'INVALID_INPUT', 'practices.io.onlyRegularFilesBeneathDirectoriesAre');
  }
  const realTarget = realpathSync(target);
  requireCondition(realTarget.startsWith(realRoot + path.sep), 'INVALID_INPUT', 'practices.io.artifactEscapesItsRoot');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    requireCondition(before.isFile(), 'INVALID_INPUT', 'practices.io.artifactMustBeARegularFile');
    requireCondition(before.size <= maxBytes, 'INVALID_INPUT', 'practices.io.artifactExceedsTheByteLimit');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd);
    requireCondition(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino, 'INTEGRITY_FAILED', 'practices.io.artifactChangedWhileBeingRead');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
export function readArtifact(root, ref, maxBytes) {
  const bytes = readBoundedFile(root, ref.path, maxBytes);
  requireCondition(hashBytes(bytes) === ref.digest, 'INTEGRITY_FAILED', 'practices.io.artifactDigestMismatch', {}, { path: ref.path });
  return bytes;
}
export function parseJson(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (cause) { throw new PracticeError('INVALID_INPUT', 'practices.io.invalidUtf8Json', {}, null, { cause }); }
  canonicalJson(value); // Bound nesting and reject non-finite values before recursion.
  return value;
}
