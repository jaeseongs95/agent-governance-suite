import { appendFileSync } from 'node:fs';
const file = process.env.AGS_CI_PROGRESS_FILE;
if (!file) throw new Error('Missing bounded CI progress destination');
let bytes = 0, completedCases = 0, completedModules = 0;
const root = process.cwd().replaceAll('\\', '/') + '/';
function record(event) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
  bytes += Buffer.byteLength(line);
  if (bytes > 128 * 1024) throw new Error('Bounded CI progress capacity exceeded');
  appendFileSync(file, line, { encoding: 'utf8' });
}
function errorFacts(error) {
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : 'UNKNOWN';
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(error.code) ? error.code : null;
  let projectFrame = null;
  if (typeof error?.stack === 'string') {
    for (const line of error.stack.replaceAll('\\', '/').split('\n')) {
      const index = line.indexOf(root);
      if (index < 0) continue;
      const match = /^([A-Za-z0-9_./@ -]+):(\d+):(\d+)/.exec(line.slice(index + root.length));
      if (match && !match[1].startsWith('node_modules/')) {
        projectFrame = { file: match[1], line: Number(match[2]), column: Number(match[3]) }; break;
      }
    }
  }
  // No raw message, expected/actual, source line, environment or token is emitted.
  return { name, code, projectFrame };
}
export default class ProgressReporter {
  onInit() { record({ event: 'init', pid: process.pid, parentPid: process.ppid }); }
  onTestRunStart(specs) { record({ event: 'run-start', scheduledModules: specs.length }); }
  onTestModuleQueued(module) { record({ event: 'module-queued', file: module.relativeModuleId }); }
  onTestModuleCollected(module) {
    const errors = module.errors();
    if (errors.length) record({ event: 'collection-failed', file: module.relativeModuleId, errors: errors.slice(0, 8).map(errorFacts) });
  }
  onTestModuleStart(module) { record({ event: 'module-start', file: module.relativeModuleId }); }
  onTestCaseResult(test) {
    completedCases++;
    const result = test.result();
    if (result.state === 'failed') record({ event: 'case-failed', file: test.module.relativeModuleId, caseId: test.id,
      errors: (result.errors ?? []).slice(0, 8).map(errorFacts), completedCases });
    if (completedCases % 50 === 0) record({ event: 'case-progress', completedCases, lastCaseId: test.id });
  }
  onTestModuleEnd(module) {
    completedModules++;
    record({ event: 'module-end', file: module.relativeModuleId, state: module.state(),
      errors: module.errors().slice(0, 8).map(errorFacts), completedModules, completedCases });
  }
  onTestRunEnd(modules, errors, reason) { record({ event: 'run-end', modules: modules.length,
    errors: errors.slice(0, 8).map(errorFacts), reason, completedCases, completedModules }); }
}
