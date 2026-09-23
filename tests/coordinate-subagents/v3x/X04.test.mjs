import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

const workflow = readFileSync(new URL('../../../.github/workflows/semantic-s1b-verification.yml', import.meta.url), 'utf8');

test('X04 separates explicit verification from the read-only bootstrap evidence path', () => {
  assert.ok(workflow.includes('on:\n  push:\n    branches:\n      - codex/v260-semantic-decision-layer'));
  assert.ok(workflow.includes('permissions:\n  contents: read'));
  assert.match(workflow, /\[semantic-s1b-bootstrap\]/u);
  assert.ok(workflow.includes("if: github.event.head_commit.message == '[semantic-s1b-bootstrap]' || github.event.head_commit.message == '[verify-semantic-s1b]'"));
  assert.ok(workflow.includes("if: github.event.head_commit.message == '[verify-semantic-s1b]'"));
  assert.match(workflow, /git archive --format=tar\.gz HEAD/u);
  assert.match(workflow, /git bundle create/u);
  assert.match(workflow, /run_check contracts pnpm exec vitest run/u);
  assert.match(workflow, /run_check full pnpm test/u);
  assert.match(workflow, /- uses: actions\/upload-artifact@v4/u);
  assert.match(workflow, /- name: Report all nonzero checks/u);
});

test('X04 quoted or negated markers skip both bootstrap and verification', () => {
  const condition = workflow.match(/^ {4}if: (.+)$/mu);
  assert.ok(condition);
  assert.equal(condition[1], "github.event.head_commit.message == '[semantic-s1b-bootstrap]' || github.event.head_commit.message == '[verify-semantic-s1b]'");
  const markers = ['[semantic-s1b-bootstrap]', '[verify-semantic-s1b]'];
  const requested = message => markers.some(marker => message.toLowerCase() === marker.toLowerCase());
  assert.equal(requested(markers[0]), true);
  assert.equal(requested(markers[1]), true);
  for (const marker of markers) {
    assert.equal(requested(`docs: quote ${marker}`), false);
    assert.equal(requested(`do not run ${marker}`), false);
  }
  assert.doesNotMatch(workflow, /contains\(/u);
});

test('X04 cannot use the obsolete opaque payload to rewrite and publish source', () => {
  assert.doesNotMatch(workflow, /\[apply-semantic-s1b\]|s1b-candidate|brotli-base64|git apply|git commit|git push|git add|contents: write|GH_TOKEN/u);
  assert.doesNotMatch(workflow, /Fast-forward only|Apply only an explicitly requested/u);
});
