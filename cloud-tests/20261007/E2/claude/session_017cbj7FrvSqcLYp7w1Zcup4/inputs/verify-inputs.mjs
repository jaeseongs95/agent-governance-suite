import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
const root = fileURLToPath(new URL('.', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const results = manifest.immutableInputs.map(file => {
  const path = resolve(root, file.path);
  if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) throw new Error('UNSAFE_PATH');
  const bytes = readFileSync(path);
  return { path: file.path, pass: bytes.length === file.bytes && createHash('sha256').update(bytes).digest('hex') === file.sha256 };
});
console.log(JSON.stringify({ verdict: results.every(x => x.pass) ? 'PASS' : 'FAIL', results }, null, 2));
process.exitCode = results.every(x => x.pass) ? 0 : 1;
