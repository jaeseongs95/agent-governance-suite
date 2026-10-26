import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = await readFile(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const block = /^concurrency:\r?\n  group: ([^\r\n]+)\r?\n  cancel-in-progress: ([^\r\n]+)/mu.exec(workflow);
assert.ok(block, 'The workflow concurrency group and cancellation policy must be explicit.');
// The authored expressions use string contexts, ==, && and ||. Evaluate that
// shared subset only; this is not a claim to execute the GitHub Actions engine.
const evaluate = (expression, github) => runInNewContext(expression, { github: Object.freeze(github) }, { timeout: 100 });
const context = overrides => ({ workflow: 'CI', ref: 'refs/heads/release-3.0', run_id: 40255252742, run_attempt: 1, ...overrides });
const group = github => block[1].replace(/\$\{\{([^}]+)\}\}/gu, (_match, expression) => String(evaluate(expression, github)));
const cancellation = github => {
  const expression = /^\$\{\{([\s\S]+)\}\}$/u.exec(block[2]);
  assert.ok(expression);
  return evaluate(expression[1], github);
};

test('release pushes with different run IDs cannot replace each other in the same concurrency group', () => {
  assert.notEqual(group(context()), group(context({ run_id: 40255252743 })));
});

test('a retry of the same release run retains its concurrency group', () => {
  assert.equal(group(context()), group(context({ run_attempt: 2 })));
});

test('release runs retain the original no-cancellation policy', () => {
  assert.equal(cancellation(context()), false);
  assert.equal(cancellation(context({ run_id: 40255252743 })), false);
});

test('main retains its original ref group and cancellation policy across runs', () => {
  const main = context({ ref: 'refs/heads/main' });
  assert.equal(group(main), 'ci-CI-refs/heads/main');
  assert.equal(group(main), group({ ...main, run_id: 40255252743 }));
  assert.equal(cancellation(main), true);
});

test('pull requests retain their original merge-ref groups and cancellation policy', () => {
  const pr = context({ ref: 'refs/pull/42/merge' });
  assert.equal(group(pr), 'ci-CI-refs/pull/42/merge');
  assert.equal(group(pr), group({ ...pr, run_id: 40255252743 }));
  assert.notEqual(group(pr), group({ ...pr, ref: 'refs/pull/43/merge' }));
  assert.equal(cancellation(pr), true);
});

test('workflow names continue to isolate groups on every supported ref kind', () => {
  for (const ref of ['refs/heads/release-3.0', 'refs/heads/main', 'refs/pull/42/merge']) {
    assert.notEqual(group(context({ ref })), group(context({ ref, workflow: 'Another workflow' })));
  }
});
