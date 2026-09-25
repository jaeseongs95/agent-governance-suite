import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [databasePath, expectedIdentity = '', option] = process.argv.slice(2);
if (!databasePath || (option && option !== '--write-schema')) {
  process.stderr.write('usage: node run.mjs <temp-db> [expected-id] [--write-schema]\n');
  process.exit(64);
}

const script = fileURLToPath(new URL('./probe.py', import.meta.url));
const args = ['-I', script, databasePath];
if (expectedIdentity || option) args.push(expectedIdentity);
if (option === '--write-schema') args.push('--write-schema');
const result = spawnSync('python3', args, { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' });
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exit(result.status ?? 1);
