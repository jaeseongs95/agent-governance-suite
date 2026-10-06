import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';

export class CsError extends Error {
  constructor(code, message, details = null) { super(message); this.name = 'CsError'; this.code = code; this.details = details; }
}
export function requireCondition(condition, code, message, details = null) {
  if (!condition) throw new CsError(code, message, details);
}
export function canonicalJson(value, depth = 0) {
  requireCondition(depth <= 64, 'INVALID_INPUT', 'JSON nesting exceeds 64.');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k], depth + 1)).join(',') + '}';
  }
  throw new CsError('INVALID_INPUT', 'Only finite JSON values and plain objects are supported.');
}
export const hashBytes = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
export const hashJson = value => hashBytes(Buffer.from(canonicalJson(value), 'utf8'));
export function uniqueBy(items, key, label) {
  const map = new Map();
  for (const item of items) {
    requireCondition(!map.has(item[key]), 'INVALID_INPUT', `Duplicate ${label}: ${item[key]}.`);
    map.set(item[key], item);
  }
  return map;
}
export function sameSet(a, b) { const left = new Set(a), right = new Set(b); return a.length === b.length && left.size === a.length && right.size === b.length && [...left].every(v => right.has(v)); }
export function portablePath(relative) {
  requireCondition(typeof relative === 'string' && relative.length > 0 && relative.length <= 4096, 'INVALID_INPUT', 'A bounded relative path is required.');
  requireCondition(!/[\\:\u0000-\u001f\u007f]/u.test(relative) && !relative.startsWith('/'), 'INVALID_INPUT', 'Absolute, drive, backslash, control and stream paths are forbidden.');
  const parts = relative.split('/');
  requireCondition(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/u.test(p) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p)), 'INVALID_INPUT', 'Unsafe path component.');
  return parts;
}
// The artifact root must be private/trusted. This is not an OS sandbox against
// an adversary concurrently replacing ancestor directories or hard links.
export function readBoundedFile(root, relative, maxBytes = 1024 * 1024) {
  const parts = portablePath(relative);
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, 'INVALID_INPUT', 'Invalid file limit.');
  const resolvedRoot = path.resolve(root);
  const rootStat = lstatSync(resolvedRoot);
  requireCondition(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'INVALID_INPUT', 'Artifact root must be a real directory.');
  const realRoot = realpathSync(resolvedRoot);
  let target = realRoot;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    const info = lstatSync(target);
    requireCondition(!info.isSymbolicLink(), 'INVALID_INPUT', 'Symlinks are not allowed in artifact paths.');
    requireCondition(i === parts.length - 1 ? info.isFile() : info.isDirectory(), 'INVALID_INPUT', 'Only regular files beneath directories are allowed.');
  }
  const realTarget = realpathSync(target);
  requireCondition(realTarget.startsWith(realRoot + path.sep), 'INVALID_INPUT', 'Artifact escapes its root.');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    requireCondition(before.isFile(), 'INVALID_INPUT', 'Artifact must be a regular file.');
    requireCondition(before.size <= maxBytes, 'INVALID_INPUT', 'Artifact exceeds the byte limit.');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd);
    requireCondition(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino, 'INTEGRITY_FAILED', 'Artifact changed while being read.');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
export function readArtifact(root, ref, maxBytes) {
  const bytes = readBoundedFile(root, ref.path, maxBytes);
  requireCondition(hashBytes(bytes) === ref.digest, 'INTEGRITY_FAILED', 'Artifact digest mismatch.', { path: ref.path });
  return bytes;
}
export function parseJson(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new CsError('INVALID_INPUT', 'Invalid UTF-8 JSON.'); }
  canonicalJson(value); // Bound nesting and reject non-finite values before recursion.
  return value;
}
