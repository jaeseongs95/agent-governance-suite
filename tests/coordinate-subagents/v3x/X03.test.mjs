import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

const workflow = readFileSync(new URL('../../../.github/workflows/semantic-contract-verification.yml', import.meta.url), 'utf8');

test('X03 runs verification only when requested on the design branch', () => {
  assert.ok(workflow.includes('on:\n  push:\n    branches:\n      - codex/v260-semantic-decision-layer'));
  assert.ok(workflow.includes('permissions:\n  contents: read'));
  assert.ok(workflow.includes("if: github.event.head_commit.message == '[verify-semantic-contracts]'"));
  assert.doesNotMatch(workflow, /\bcontents: write\b|\bGH_TOKEN\b|\[apply-semantic-contracts\]/u);
  assert.match(workflow, /- name: Verify in order and retain every exit code/u);
  assert.match(workflow, /run_check contracts pnpm exec vitest run/u);
  assert.match(workflow, /run_check full pnpm test/u);
  assert.match(workflow, /- uses: actions\/upload-artifact@v4/u);
});

test('X03 quoted or negated marker messages skip the verification job', () => {
  const condition = workflow.match(/^ {4}if: github\.event\.head_commit\.message == '([^']+)'$/mu);
  assert.ok(condition);
  const requested = message => message.toLowerCase() === condition[1].toLowerCase();
  assert.equal(requested('[verify-semantic-contracts]'), true);
  assert.equal(requested('docs: quote [verify-semantic-contracts]'), false);
  assert.equal(requested('do not run [verify-semantic-contracts]'), false);
});

test('X03 cannot replay the obsolete source payload or publish a source change', () => {
  assert.doesNotMatch(workflow, /s1a-candidate|brotli-base64-parts|git apply|git commit|git push|git add/u);
  assert.doesNotMatch(workflow, /Fast-forward only|Apply an explicitly requested/u);
});
