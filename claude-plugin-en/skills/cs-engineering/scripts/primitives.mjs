import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { hostText } from './messages.mjs';

export class CsError extends Error {
  constructor(code, message, details = null) { super(message); this.name = 'CsError'; this.code = code; this.details = details; }
}
// The message is a catalog key rendered only on failure, so passing checks pay no rendering cost.
export function requireCondition(condition, code, key, params = {}, details = null) {
  if (!condition) throw new CsError(code, hostText(key, params), details);
}
export function canonicalJson(value, depth = 0) {
  requireCondition(depth <= 64, 'INVALID_INPUT', 'skillTools.csEngineering.jsonNesting');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => canonicalJson(v, depth + 1)).join(',') + ']';
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k], depth + 1)).join(',') + '}';
  }
  throw new CsError('INVALID_INPUT', hostText('skillTools.csEngineering.nonJsonValue'));
}
export const hashBytes = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
export const hashJson = value => hashBytes(Buffer.from(canonicalJson(value), 'utf8'));
export function uniqueBy(items, key, label) {
  const map = new Map();
  for (const item of items) {
    requireCondition(!map.has(item[key]), 'INVALID_INPUT', 'skillTools.csEngineering.duplicate', { label, value: item[key] });
    map.set(item[key], item);
  }
  return map;
}
export function sameSet(a, b) { const left = new Set(a), right = new Set(b); return a.length === b.length && left.size === a.length && right.size === b.length && [...left].every(v => right.has(v)); }
export function portablePath(relative) {
  requireCondition(typeof relative === 'string' && relative.length > 0 && relative.length <= 4096, 'INVALID_INPUT', 'skillTools.csEngineering.boundedPathRequired');
  requireCondition(!/[\\:\u0000-\u001f\u007f]/u.test(relative) && !relative.startsWith('/'), 'INVALID_INPUT', 'skillTools.csEngineering.forbiddenPathForm');
  const parts = relative.split('/');
  requireCondition(parts.every(p => p && p !== '.' && p !== '..' && !/[. ]$/u.test(p) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu.test(p)), 'INVALID_INPUT', 'skillTools.csEngineering.unsafePathComponent');
  return parts;
}
// The artifact root must be private/trusted. This is not an OS sandbox against
// an adversary concurrently replacing ancestor directories or hard links.
export function readBoundedFile(root, relative, maxBytes = 1024 * 1024) {
  const parts = portablePath(relative);
  requireCondition(Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= 64 * 1024 * 1024, 'INVALID_INPUT', 'skillTools.csEngineering.invalidFileLimit');
  const resolvedRoot = path.resolve(root);
  const rootStat = lstatSync(resolvedRoot);
  requireCondition(rootStat.isDirectory() && !rootStat.isSymbolicLink(), 'INVALID_INPUT', 'skillTools.csEngineering.rootNotRealDirectory');
  const realRoot = realpathSync(resolvedRoot);
  let target = realRoot;
  for (let i = 0; i < parts.length; i++) {
    target = path.join(target, parts[i]);
    const info = lstatSync(target);
    requireCondition(!info.isSymbolicLink(), 'INVALID_INPUT', 'skillTools.csEngineering.symlinkNotAllowed');
    requireCondition(i === parts.length - 1 ? info.isFile() : info.isDirectory(), 'INVALID_INPUT', 'skillTools.csEngineering.onlyRegularFiles');
  }
  const realTarget = realpathSync(target);
  requireCondition(realTarget.startsWith(realRoot + path.sep), 'INVALID_INPUT', 'skillTools.csEngineering.artifactEscapesRoot');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = fstatSync(fd);
    requireCondition(before.isFile(), 'INVALID_INPUT', 'skillTools.csEngineering.artifactNotRegularFile');
    requireCondition(before.size <= maxBytes, 'INVALID_INPUT', 'skillTools.csEngineering.artifactTooLarge');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd);
    requireCondition(length === before.size && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs && before.ino === after.ino, 'INTEGRITY_FAILED', 'skillTools.csEngineering.artifactChanged');
    return buffer.subarray(0, length);
  } finally { closeSync(fd); }
}
export function readArtifact(root, ref, maxBytes) {
  const bytes = readBoundedFile(root, ref.path, maxBytes);
  requireCondition(hashBytes(bytes) === ref.digest, 'INTEGRITY_FAILED', 'skillTools.csEngineering.artifactDigestMismatch', {}, { path: ref.path });
  return bytes;
}
export function parseJson(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new CsError('INVALID_INPUT', hostText('skillTools.csEngineering.invalidUtf8Json')); }
  canonicalJson(value); // Bound nesting and reject non-finite values before recursion.
  return value;
}
