import assert from 'node:assert/strict';
import { test } from 'vitest';
import { normalizeClaudeModelResponse } from '../../../mcp-server/src/native-adapters/claude/model-response-normalizer.ts';

const requestedModel = 'claude-opus-5-5';
const normalize = (response, streamEvents = []) =>
  normalizeClaudeModelResponse({ requestedModel, response, streamEvents });

test('M06 preserves raw blocks and separates screen text from continuation data', () => {
  const response = { type: 'message', model: requestedModel, stop_reason: 'tool_use',
    content: [
      { type: 'thinking', thinking: '', signature: 'signed-opaque' },
      { type: 'text', text: 'Working on it.' },
      { type: 'tool_use', id: 'tool-1', name: 'lookup', input: { key: 'x' } },
      { type: 'new_block_type', opaque: { keep: true } },
    ], usage: { input_tokens: 2, output_tokens: 8 } };
  const original = structuredClone(response);
  const result = normalize(response);
  assert.equal(result.status, 'terminal');
  assert.equal(result.stop.reason, 'tool_use');
  assert.equal(result.display.text, 'Working on it.');
  assert.deepEqual(result.content.map(block => block.kind), ['thinking', 'text', 'tool', 'unknown']);
  assert.deepEqual(result.continuationBlocks, response.content);
  assert.notStrictEqual(result.continuationBlocks, response.content);
  assert.deepEqual(result.rawResponse, original);
  assert.deepEqual(response, original);
  assert.equal(result.model.exposed, requestedModel);
  assert.equal(result.model.source, 'response.model');
  assert.equal(result.model.admitted, false);
  assert.deepEqual(result.usage, { value: response.usage, source: 'response.usage', admitted: false });
  assert.equal(result.executionAuthorized, false);
});

test('M06 empty progress and a thinking-first partial stream do not prove completion or hang', () => {
  const events = [
    { type: 'message_start', message: { model: requestedModel, content: [] } },
    { type: 'ping' },
    { type: 'content_block_start', index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
  ];
  const result = normalize(undefined, events);
  assert.equal(result.status, 'partial-stream');
  assert.deepEqual(result.progress.map(item => item.kind),
    ['start', 'unknown', 'thinking', 'thinking', 'thinking']);
  assert.equal(result.display.text, '');
  assert.equal(result.display.provisional, true);
  assert.equal(result.stop.reason, null);
  assert.equal(result.model.exposed, null);
  assert.equal(result.model.hiddenBackend, 'unknown');
  assert.equal(result.continuationBlocks, null);
  assert.equal(normalize(undefined, [{ type: 'ping' }]).status, 'partial-stream');
});

test('M06 categorizes refusal and max_tokens without retrying or showing partial refusal text', () => {
  const refusal = normalize({ model: requestedModel, stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'new_policy_area' },
    content: [{ type: 'text', text: 'partial content' }], usage: { output_tokens: 2 } });
  assert.equal(refusal.stop.kind, 'refusal');
  assert.equal(refusal.stop.category, 'new_policy_area');
  assert.equal(refusal.stop.categoryRecognized, false);
  assert.equal(refusal.display.text, '');
  assert.equal(refusal.continuationBlocks, null);
  assert.equal(refusal.fallback.selfRetryPerformed, false);
  assert.equal(refusal.fallback.providerObserved, false);
  const truncated = normalize({ model: requestedModel, stop_reason: 'max_tokens',
    content: [{ type: 'text', text: 'unfinished' }], usage: { output_tokens: 10 } });
  assert.equal(truncated.stop.kind, 'truncated');
  assert.equal(truncated.display.text, 'unfinished');
  assert.deepEqual(truncated.continuationBlocks, [{ type: 'text', text: 'unfinished' }]);
  assert.equal(truncated.model.hiddenBackend, 'unknown');
});

test('M06 keeps provider fallback observation separate from request mismatch and self retry', () => {
  const response = { model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'fallback', from: { model: requestedModel },
      to: { model: 'claude-opus-5' } }, { type: 'text', text: 'answer' }],
    usage: { iterations: [{ type: 'message', model: requestedModel },
      { type: 'fallback_message', model: 'claude-opus-5' }] } };
  const result = normalize(response);
  assert.equal(result.model.exposed, 'claude-opus-5');
  assert.equal(result.model.mismatch, true);
  assert.equal(result.fallback.providerObserved, true);
  assert.equal(result.fallback.selfRetryPerformed, false);
  assert.equal(result.model.admitted, false);
  const mismatchOnly = normalize({ model: 'claude-opus-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'answer' }] });
  assert.equal(mismatchOnly.model.mismatch, true);
  assert.equal(mismatchOnly.fallback.providerObserved, false);
  const markerOnly = normalize({ stop_reason: 'end_turn', content: [
    { type: 'fallback', to: { model: 'claude-opus-5' } },
  ] });
  assert.equal(markerOnly.model.exposed, 'claude-opus-5');
  assert.equal(markerOnly.model.source, 'response.content.fallback.to.model');
  assert.equal(normalize({ stop_reason: 'end_turn', content: [] }).model.exposed, null);
});

test('M06 completed stream uses final fallback marker and usage; unknown events remain unknown', () => {
  const events = [
    { type: 'message_start', message: { model: requestedModel } },
    { type: 'content_block_start', index: 0,
      content_block: { type: 'fallback', from: { model: requestedModel },
        to: { model: 'claude-opus-5' } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
    { type: 'future_event', value: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5, iterations: [{ type: 'fallback_message', model: 'claude-opus-5' }] } },
    { type: 'message_stop' },
  ];
  const result = normalize(undefined, events);
  assert.equal(result.status, 'terminal');
  assert.equal(result.model.exposed, 'claude-opus-5');
  assert.equal(result.model.source, 'stream.fallback.to.model');
  assert.equal(result.usage.source, 'stream.message_delta.usage');
  assert.equal(result.progress[4].kind, 'unknown');
  assert.equal(result.progress[6].kind, 'terminal');
  assert.equal(result.display.text, 'answer');
  assert.equal(result.continuationBlocks, null);
  assert.equal(result.fallback.providerObserved, true);
  const interrupted = normalize(undefined, events.slice(0, -1));
  assert.equal(interrupted.status, 'partial-stream');
  assert.equal(interrupted.model.exposed, null);
  assert.equal(interrupted.continuationBlocks, null);
});

test('M06 merges streaming usage and retains an earlier stop reason', () => {
  const events = [
    { type: 'message_start', message: { model: requestedModel,
      usage: { input_tokens: 7, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 3 } },
    { type: 'message_delta', delta: {},
      usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  const result = normalize(undefined, events);
  assert.equal(result.status, 'terminal');
  assert.equal(result.stop.reason, 'end_turn');
  assert.deepEqual(result.usage.value, { input_tokens: 7, output_tokens: 5 });
  assert.equal(result.usage.source, 'stream.merged.usage');
});
