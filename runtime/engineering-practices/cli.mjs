import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PracticeError, requireCondition as need, readBoundedFile, parseJson, hashBytes } from './io.mjs';
import { captureSnapshot, validatePlan, validateProof, validateReview, selfCheck, loadCatalog, providerResult } from './core.mjs';
import { runCommand } from './runner.mjs';
const COMMANDS = {
  'self-check': [], 'catalog': ['module'], 'snapshot': ['root', 'files'],
  'run': ['root', 'snapshot', 'timeout-ms', 'environment-note'],
  'check-plan': ['root', 'plan'], 'check-proof': ['root', 'plan', 'proof'],
  'check-review': ['root', 'request', 'report'], 'provider-result': ['root', 'capability', 'result', 'locator']
};
export function parseArgs(argv) {
  const [cmd, ...tokens] = argv; need(Object.hasOwn(COMMANDS, cmd), 'INVALID_INPUT', 'Unknown command. Use self-check, catalog, snapshot, run, check-plan, check-proof, check-review or provider-result.');
  const options = Object.create(null); let command = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === '--') { need(cmd === 'run', 'INVALID_INPUT', 'Command separator is only valid for run.'); command = tokens.slice(i + 1); break; }
    need(t.startsWith('--') && COMMANDS[cmd].includes(t.slice(2)), 'INVALID_INPUT', 'Unknown option.');
    const key = t.slice(2); need(!Object.hasOwn(options, key) && tokens[i + 1] && !tokens[i + 1].startsWith('--'), 'INVALID_INPUT', 'Duplicate or missing option value.');
    options[key] = tokens[++i];
  }
  if (!['self-check', 'catalog'].includes(cmd)) need(options.root, 'INVALID_INPUT', '--root is required.');
  const required = { snapshot: ['files'], run: ['snapshot'], 'check-plan': ['plan'], 'check-proof': ['plan', 'proof'], 'check-review': ['request', 'report'], 'provider-result': ['capability', 'result', 'locator'] };
  for (const k of required[cmd] ?? []) need(options[k], 'INVALID_INPUT', `--${k} is required.`);
  if (cmd === 'run') need(command.length, 'INVALID_INPUT', 'Supply the explicit command after --.');
  return { cmd, options, command };
}
export function execute(argv) {
  const { cmd, options: o, command } = parseArgs(argv);
  const read = p => parseJson(readBoundedFile(o.root, p, 8 * 1024 * 1024));
  if (cmd === 'self-check') return { value: selfCheck(), exitCode: 0 };
  if (cmd === 'catalog') { const c = loadCatalog(); need(!o.module || c.rules.some(r => r.module === o.module), 'INVALID_INPUT', 'Unknown module.'); return { value: { ...c, rules: o.module ? c.rules.filter(r => r.module === o.module) : c.rules }, exitCode: 0 }; }
  if (cmd === 'snapshot') { const p = read(o.files); need(Array.isArray(p), 'INVALID_INPUT', 'File selection must be a JSON array of relative paths.'); return { value: captureSnapshot(o.root, p), exitCode: 0 }; }
  if (cmd === 'run') {
    const timeoutMs = o['timeout-ms'] === undefined ? 30000 : Number(o['timeout-ms']);
    const value = runCommand(o.root, read(o.snapshot), command, { timeoutMs, ...(o['environment-note'] ? { environmentNote: o['environment-note'] } : {}) });
    return { value, exitCode: value.status === 'PASS' ? 0 : 1 };
  }
  if (cmd === 'check-plan') return { value: validatePlan(read(o.plan)), exitCode: 0 };
  if (cmd === 'check-proof') { const value = validateProof(o.root, read(o.plan), read(o.proof)); return { value, exitCode: value.verdict === 'CONSISTENT' ? 0 : 1 }; }
  if (cmd === 'check-review') { const value = validateReview(o.root, read(o.request), read(o.report)); return { value, exitCode: value.verdict === 'NO_BLOCKING_FINDINGS' ? 0 : 1 }; }
  return { value: providerResult(o.capability, read(o.result), o.locator, hashBytes(readBoundedFile(o.root, o.result, 8 * 1024 * 1024))), exitCode: 0 };
}
export async function main(argv) {
  try { const { value, exitCode } = execute(argv); console.log(JSON.stringify(value, null, 2)); process.exitCode = exitCode; }
  catch (e) { console.error(JSON.stringify({ status: 'ERROR', code: e instanceof PracticeError ? e.code : 'IO_ERROR', message: e instanceof PracticeError ? e.message : 'Could not read or execute the explicitly requested local input.' }, null, 2)); process.exitCode = 2; }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
