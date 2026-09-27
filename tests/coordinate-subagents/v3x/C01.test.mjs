import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test } from 'vitest';
import { CONTEXT_TRANSITION_ACTIONS, CONTEXT_TRANSITION_STATUSES } from '../../../contracts/types.ts';
import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';

const validator = new ContractValidator();
const actions = ['CONTINUE', 'CHECKPOINT_AND_CONTINUE', 'COMPACT_AND_CONTINUE', 'NEW_ISOLATED_REVIEW_SESSION', 'CLOSE'];
const hash = value => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const receiver = { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' };
const checkpoint = { schemaVersion: '1.0.0', namespace: 'checkpoint-evidence', id: 'checkpoint-1',
  digest: `sha256:${'a'.repeat(64)}`, hashDomain: 'raw-bytes', size: 16, mediaType: 'application/json' };
const intent = (action = 'CONTINUE') => ({ schemaVersion: '1.0.0', kind: 'context-transition-intent',
  status: 'request', action, binding: { transitionId: 'transition-1', taskId: 'task-1', revision: 2,
    receiver: { ...receiver }, contextGeneration: 3, checkpoint: { ...checkpoint } } });

function result(request, status = 'completed') {
  const value = { schemaVersion: '1.0.0', kind: 'context-transition-result', status, action: request.action,
    binding: structuredClone(request.binding), intentDigest: hash(request), baseState: 'unchanged',
    target: { receiver: { ...request.binding.receiver }, contextGeneration: request.binding.contextGeneration, origin: 'same-context' } };
  if (['started', 'failed', 'uncertain'].includes(status)) {
    value.baseState = 'invalid'; value.target = null;
    if (status !== 'started') value.reason = 'fixture-observation';
  } else if (status === 'completed') {
    if (request.action === 'COMPACT_AND_CONTINUE') {
      value.baseState = 'invalid'; value.target.origin = 'compacted'; value.target.contextGeneration += 1;
    } else if (request.action === 'NEW_ISOLATED_REVIEW_SESSION') {
      value.baseState = 'invalid';
      value.target = { receiver: { host: 'codex', sessionId: 'review-1', instanceId: 'instance-2' },
        contextGeneration: 0, origin: 'fresh-context', historyInherited: false };
    } else if (request.action === 'CLOSE') { value.baseState = 'invalid'; value.target = null; }
  }
  return value;
}

test('C01 separates five actions and six statuses without equating an intent with completion', () => {
  assert.deepEqual([...CONTEXT_TRANSITION_ACTIONS], actions);
  assert.deepEqual([...CONTEXT_TRANSITION_STATUSES], ['request', 'started', 'completed', 'no-op', 'failed', 'uncertain']);
  for (const action of actions) {
    const request = intent(action);
    assert.deepEqual(validator.contextTransitionIntent(request), request);
    assert.throws(() => validator.contextTransitionResult(request), { code: 'INVALID_INPUT' });
    for (const status of ['started', 'completed', 'no-op', 'failed', 'uncertain']) {
      const observed = result(request, status);
      assert.deepEqual(validator.contextTransitionResult(observed), observed);
      assert.deepEqual(validator.contextTransitionResultForIntent(observed, request), observed);
      assert.throws(() => validator.contextTransitionIntent(observed), { code: 'INVALID_INPUT' });
    }
  }
});

test('C01 TypeScript unions accept valid declarations and reject impossible action/status outcomes', () => {
  // Reuse the existing semantic type-parity suite's virtual compiler pattern; write no extra files.
  const virtual = path.join(fileURLToPath(new URL('../../../', import.meta.url)), 'contracts', '__c01_parity_virtual.ts');
  const declarations = actions.flatMap(action => [{ type: 'ContextTransitionIntentV1', value: intent(action) },
    ...['started', 'completed', 'no-op', 'failed', 'uncertain'].map(status =>
      ({ type: 'ContextTransitionResultV1', value: result(intent(action), status) }))]);
  const invalid = [
    { ...result(intent()), status: 'request' },
    { ...result(intent('CLOSE')), target: result(intent()).target },
    { ...result(intent('COMPACT_AND_CONTINUE')), baseState: 'unchanged' },
    { ...result(intent(), 'started'), target: result(intent()).target },
    { ...result(intent(), 'no-op'), target: null },
    { ...result(intent('NEW_ISOLATED_REVIEW_SESSION')), target: { ...result(intent('NEW_ISOLATED_REVIEW_SESSION')).target,
      historyInherited: true } },
  ];
  const source = 'import type * as Actual from "./types.js";\n' + declarations.map((declaration, index) =>
    `const valid${index} = ${JSON.stringify(declaration.value)} as const satisfies Actual.${declaration.type};`).join('\n')
    + '\n' + invalid.map((value, index) =>
      `// @ts-expect-error impossible declaration\nconst invalid${index} = ${JSON.stringify(value)} as const satisfies Actual.ContextTransitionResultV1;`).join('\n');
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, exactOptionalPropertyTypes: true,
    skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile.bind(host);
  const exists = host.fileExists.bind(host);
  host.fileExists = file => path.normalize(file) === virtual || exists(file);
  host.getSourceFile = (file, version, onError, shouldCreate) => path.normalize(file) === virtual
    ? ts.createSourceFile(file, source, version, true) : original(file, version, onError, shouldCreate);
  const program = ts.createProgram([virtual], options, host);
  assert.deepEqual(ts.getPreEmitDiagnostics(program).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')), []);
});

test('C01 rejects invalid action/status unions, caller commands and outcome fields on requests', () => {
  for (const action of ['FORK_INDEPENDENT', 'NEW_SESSION', 'history-fork', 'compact']) {
    assert.throws(() => validator.contextTransitionIntent({ ...intent(), action }), { code: 'INVALID_INPUT' });
  }
  for (const status of ['completed', 'started', 'no_op', 'success']) {
    assert.throws(() => validator.contextTransitionIntent({ ...intent(), status }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => validator.contextTransitionIntent({ ...intent(), command: '/compact' }), { code: 'INVALID_INPUT' });
  assert.throws(() => validator.contextTransitionIntent({ ...intent(), target: null }), { code: 'INVALID_INPUT' });
  for (const status of ['request', 'success', 'cancelled']) {
    assert.throws(() => validator.contextTransitionResult({ ...result(intent()), status }), { code: 'INVALID_INPUT' });
  }
});

test('C01 rejects incomplete, unsafe and unbound identities using checkpoint-delta conventions', () => {
  for (const changes of [{ taskId: '' }, { transitionId: '../escape' }, { revision: -1 }, { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 }, { contextGeneration: -1 }, { contextGeneration: 0.1 },
    { receiver: { host: 'codex', sessionId: 'session-1' } }, { receiver: { ...receiver, host: 'vendor command' } },
    { checkpoint: { ...checkpoint, verified: true } }, { checkpoint: { ...checkpoint, digest: 'unhashed' } }]) {
    const request = intent(); request.binding = { ...request.binding, ...changes };
    assert.throws(() => validator.contextTransitionIntent(request), { code: 'INVALID_INPUT' });
  }
  const blinded = intent(); blinded.binding.taskId = `hmac-sha256:${'b'.repeat(64)}`;
  validator.contextTransitionIntent(blinded);
  const zero = intent(); zero.binding.revision = 0; zero.binding.contextGeneration = 0;
  validator.contextTransitionIntent(zero);
});

test('C01 binds a result to its immutable transition/task/revision/host/generation/checkpoint intent', () => {
  const expected = intent();
  const changes = [binding => { binding.transitionId = 'transition-2'; }, binding => { binding.taskId = 'task-2'; },
    binding => { binding.revision += 1; }, binding => { binding.receiver.host = 'another-host'; },
    binding => { binding.receiver.sessionId = 'session-2'; }, binding => { binding.receiver.instanceId = 'instance-2'; },
    binding => { binding.contextGeneration += 1; }, binding => { binding.checkpoint.digest = `sha256:${'b'.repeat(64)}`; }];
  for (const change of changes) {
    const other = structuredClone(expected); change(other.binding);
    const observed = result(other);
    validator.contextTransitionResult(observed);
    assert.throws(() => validator.contextTransitionResultForIntent(observed, expected), { code: 'GATE_FAILED' });
  }
  assert.throws(() => validator.contextTransitionResultForIntent(result(intent('CLOSE')), expected), { code: 'GATE_FAILED' });
  const corrupted = result(expected); corrupted.intentDigest = `sha256:${'f'.repeat(64)}`;
  assert.throws(() => validator.contextTransitionResult(corrupted), { code: 'INTEGRITY_FAILED' });
});

test('C01 keeps transition/unknown/destructive completion bases invalid and does not synthesize an ACK', () => {
  for (const status of ['started', 'failed', 'uncertain']) {
    const observed = result(intent('COMPACT_AND_CONTINUE'), status);
    assert.equal(validator.contextTransitionResult(observed).baseState, 'invalid');
    assert.equal(observed.target, null);
    assert.throws(() => validator.contextTransitionResult({ ...observed, baseState: 'unchanged' }), { code: 'INVALID_INPUT' });
    assert.throws(() => validator.contextTransitionResult({ ...observed, target: result(intent()).target }), { code: 'INVALID_INPUT' });
  }
  for (const action of ['COMPACT_AND_CONTINUE', 'NEW_ISOLATED_REVIEW_SESSION', 'CLOSE']) {
    const observed = result(intent(action));
    assert.equal(validator.contextTransitionResult(observed).baseState, 'invalid');
    assert.throws(() => validator.contextTransitionResult({ ...observed, baseState: 'unchanged' }), { code: 'INVALID_INPUT' });
    assert.throws(() => validator.contextTransitionResult({ ...observed, baseAck: true }), { code: 'INVALID_INPUT' });
  }
  for (const status of ['failed', 'uncertain']) {
    const missing = result(intent(), status); delete missing.reason;
    assert.throws(() => validator.contextTransitionResult(missing), { code: 'INVALID_INPUT' });
  }
});

test('C01 no-op and same-context completion cannot silently change receiver or generation', () => {
  for (const action of actions) {
    const observed = result(intent(action), 'no-op');
    observed.target.contextGeneration += 1;
    assert.throws(() => validator.contextTransitionResult(observed), { code: 'INVALID_INPUT' });
  }
  for (const action of ['CONTINUE', 'CHECKPOINT_AND_CONTINUE']) {
    const observed = result(intent(action)); observed.target.receiver.instanceId = 'instance-2';
    assert.throws(() => validator.contextTransitionResult(observed), { code: 'INVALID_INPUT' });
  }
});

test('C01 compact changes generation even when the host/session/instance is unchanged', () => {
  const request = intent('COMPACT_AND_CONTINUE');
  const observed = result(request);
  assert.deepEqual(observed.target.receiver, request.binding.receiver);
  validator.contextTransitionResult(observed);
  for (const generation of [2, 3, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => validator.contextTransitionResult({ ...observed,
      target: { ...observed.target, contextGeneration: generation } }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => validator.contextTransitionResult({ ...observed,
    target: { ...observed.target, receiver: { ...receiver, sessionId: 'other' } } }), { code: 'INVALID_INPUT' });
});

test('C01 rejects history-fork and inherited-history declarations for the isolated review action', () => {
  const observed = result(intent('NEW_ISOLATED_REVIEW_SESSION'));
  validator.contextTransitionResult(observed);
  for (const target of [{ ...observed.target, origin: 'history-fork' }, { ...observed.target, historyInherited: true },
    { ...observed.target, receiver: { ...receiver, instanceId: 'instance-2' } }]) {
    assert.throws(() => validator.contextTransitionResult({ ...observed, target }), { code: 'INVALID_INPUT' });
  }
  const missing = structuredClone(observed); delete missing.target.historyInherited;
  assert.throws(() => validator.contextTransitionResult(missing), { code: 'INVALID_INPUT' });
  // A shape-valid host observation is still not authenticated by this contract parser.
  assert.equal(Object.hasOwn(observed, 'approved'), false);
});
