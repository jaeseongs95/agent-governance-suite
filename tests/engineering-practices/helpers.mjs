import { mkdtempSync, cpSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildExample } from './build-example.node.mjs';
import { hashBytes, hashJson } from '../../runtime/engineering-practices/io.mjs';
const seed = mkdtempSync(path.join(tmpdir(), 'ags-practices-seed-'));
const data = buildExample(seed);
process.on('exit', () => rmSync(seed, { recursive: true, force: true }));
export function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-practices-test-')); cpSync(seed, root, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, ...structuredClone(data) };
}
export function writeJson(root, rel, value) {
  const b = Buffer.from(JSON.stringify(value, null, 2) + '\n'); mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); writeFileSync(path.join(root, rel), b); return { path: rel, digest: hashBytes(b) };
}
export function readJson(root, rel) { return JSON.parse(readFileSync(path.join(root, rel), 'utf8')); }
export const H = x => hashJson(x);
