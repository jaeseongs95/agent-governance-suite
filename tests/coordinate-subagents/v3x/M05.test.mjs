import assert from 'node:assert/strict';
import { test } from 'vitest';
import { guardClaudeConversationBinding, classifyClaudeThinkingTransformation,
  claudeIndependentReviewEvidence } from '../../../mcp-server/src/native-adapters/claude/conversation-binding.ts';

const thinking = { type: 'thinking', thinking: '', signature: 'opaque-signature' };
const original = { system: 'fixed', tools: [{ name: 'lookup' }], messages: [
  { role: 'user', content: 'question' },
  { role: 'assistant', content: [thinking, { type: 'text', text: 'answer' }] },
] };
const guard = (next, change = 'append', surface = 'messages-api-direct', nextModelId = 'claude-opus-5-5') =>
  guardClaudeConversationBinding({ surface, previousModelId: 'claude-opus-5-5', nextModelId,
    previous: original, next, change });

test('M05 preserves same-model append-only history and an asymmetric model switch without rewriting thinking', () => {
  const next = { ...original, messages: [...original.messages, { role: 'user', content: 'next' }] };
  const before = structuredClone(next);
  assert.deepEqual(guard(next), { status: 'append-only', historyAction: 'preserve-original',
    modelChanged: false, modelCompatibility: 'provider-decides', dispatchAuthorized: false });
  assert.deepEqual(next, before);
  assert.equal(next.messages[1].content[0], thinking);
  assert.equal(classifyClaudeThinkingTransformation({ type: 'thinking_dropped', reason: 'model_binding_mismatch' }), 'model-binding-drop');
  assert.deepEqual(guard(next, 'append', 'messages-api-direct', 'claude-fable-5-1'), {
    status: 'append-only', historyAction: 'preserve-original', modelChanged: true,
    modelCompatibility: 'provider-decides', dispatchAuthorized: false });
  assert.equal(guard(next, 'append', 'messages-api-direct', 'gpt-6-sol').status, 'unsupported-target');
});

test('M05 detects prefix edits and stale thinking after client summary', () => {
  assert.deepEqual(guard({ ...original, system: 'changed' }), { status: 'prefix-edited', field: 'system', dispatchAuthorized: false });
  assert.deepEqual(guard({ ...original, tools: [{ name: 'changed' }] }), { status: 'prefix-edited', field: 'tools', dispatchAuthorized: false });
  assert.deepEqual(guard({ ...original, messages: [
    { role: 'user', content: 'summary' }, original.messages[1],
  ] }), { status: 'prefix-edited', field: 'messages', dispatchAuthorized: false });
  assert.deepEqual(guard({ ...original, messages: [original.messages[0]] }), { status: 'prefix-edited', field: 'messages', dispatchAuthorized: false });
  assert.equal(classifyClaudeThinkingTransformation({ type: 'thinking_dropped', reason: 'prefix_binding_mismatch' }), 'prefix-binding-drop');
});

test('M05 leaves native history and provider compaction to their owners', () => {
  assert.deepEqual(guard({}, 'append', 'claude-code-managed'), { status: 'native-owned', dispatchAuthorized: false });
  assert.deepEqual(guard({}, 'append', 'claude-agent-sdk-managed'), { status: 'native-owned', dispatchAuthorized: false });
  assert.deepEqual(guard(original, 'provider-compaction'), { status: 'provider-validation-required', dispatchAuthorized: false });
  assert.deepEqual(guard(original, 'checkpoint-new-session'), { status: 'checkpoint-authorization-required', dispatchAuthorized: false });
});

test('M05 keeps unobserved enforcement unknown and limits independent review to allowed evidence', () => {
  assert.equal(classifyClaudeThinkingTransformation(undefined), 'unknown');
  assert.equal(classifyClaudeThinkingTransformation({ type: 'future', reason: 'model_binding_mismatch' }), 'unknown');
  assert.equal(classifyClaudeThinkingTransformation({ type: 'thinking_mismatch_allowed', reason: 'prefix_binding_mismatch' }), 'prefix-binding-allowed');
  assert.deepEqual(claudeIndependentReviewEvidence([
    { id: 'test-log', kind: 'test-result' }, { id: 'raw-thinking', kind: 'provider-transcript' },
    { id: 'summary', kind: 'checkpoint-summary' },
  ], new Set(['test-log', 'raw-thinking'])), [{ id: 'test-log', kind: 'test-result' }]);
});
