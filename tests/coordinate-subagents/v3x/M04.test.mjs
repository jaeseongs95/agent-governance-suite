import assert from 'node:assert/strict';
import { test } from 'vitest';
import { guardClaudeModelRequest, validateClaudeRequiredToolResult } from '../../../mcp-server/src/native-adapters/claude/model-request-guard.ts';

const base = { surface: 'messages-api-direct', modelId: 'claude-opus-5-5',
  nativeControl: { kind: 'enum', value: 'high' }, minimumEffort: 'high' };
const code = request => guardClaudeModelRequest(request).code;

test('M04 preserves a required high instead of falling through to the medium default', () => {
  const accepted = guardClaudeModelRequest(base);
  assert.equal(accepted.status, 'compatible-settings');
  assert.equal(accepted.effort, 'high');
  assert.equal(accepted.hostSupported, 'unknown');
  assert.equal(accepted.dispatchAuthorized, false);
  assert.equal(code({ ...base, nativeControl: { kind: 'not-exposed' } }), 'UNSUPPORTED_NATIVE_CONTROL');
  assert.equal(code({ ...base, nativeControl: { kind: 'enum', value: 'medium' } }), 'EFFORT_BELOW_FLOOR');
  assert.equal(code({ ...base, nativeControl: { kind: 'enum', value: 'ultra' } }), 'UNSUPPORTED_EFFORT');
});

test('M04 rejects unsupported native controls and keeps API fields off the managed CLI', () => {
  for (const nativeControl of [{ kind: 'toggle', enabled: true }, { kind: 'token-budget', budgetTokens: 4096 }]) {
    assert.equal(code({ ...base, nativeControl }), 'UNSUPPORTED_NATIVE_CONTROL');
  }
  const managed = { ...base, surface: 'claude-code-managed' };
  assert.equal(guardClaudeModelRequest(managed).status, 'compatible-settings');
  assert.equal(code({ ...managed, thinking: { type: 'disabled' } }), 'API_FIELD_ON_MANAGED_HOST');
  assert.equal(code({ ...managed, toolChoice: { type: 'auto' } }), 'API_FIELD_ON_MANAGED_HOST');
});

test('M04 checks Opus 5.5 Messages API thinking, tool and computer settings before a call', () => {
  assert.equal(code({ ...base, thinking: { type: 'disabled' } }), 'UNSUPPORTED_THINKING');
  assert.equal(code({ ...base, thinking: { type: 'enabled', budget_tokens: 4096 } }), 'UNSUPPORTED_THINKING');
  for (const type of ['any', 'tool']) assert.equal(code({ ...base, toolChoice: { type } }), 'UNSUPPORTED_FORCED_TOOL');
  assert.equal(code({ ...base, computerTool: { platform: 'anthropic-api', type: 'computer_20251124' } }), 'UNSUPPORTED_COMPUTER_TOOL');
  assert.equal(code({ ...base, computerTool: { platform: 'google-cloud', type: 'computer_20251124' } }), 'UNSUPPORTED_COMPUTER_TOOL');
  assert.equal(guardClaudeModelRequest({ ...base, computerTool: { platform: 'bedrock', type: 'computer_20251124' } }).status, 'compatible-settings');
});

test('M04 never treats auto or a missing tool result as fulfillment of a required tool', () => {
  const requiredTool = { name: 'lookup', alternative: 'strict-auto', validateDomain: (_input, result) => result?.ok === true };
  const request = { ...base, toolChoice: { type: 'auto' }, tools: [{ name: 'lookup', strict: true }], requiredTool };
  assert.equal(code({ ...base, toolChoice: { type: 'auto' }, requiredTool }), 'REQUIRED_TOOL_UNENFORCED');
  assert.equal(code({ ...request, requiredTool: { ...requiredTool, validateDomain: undefined } }), 'REQUIRED_TOOL_UNENFORCED');
  assert.equal(guardClaudeModelRequest(request).requiresToolResultValidation, true);
  assert.equal(validateClaudeRequiredToolResult(request, { content: [{ type: 'text', text: 'done' }] }, []).code, 'REQUIRED_TOOL_MISSING');
  const response = { content: [{ type: 'tool_use', id: 'tool-1', name: 'lookup', input: { key: 'a' } }] };
  assert.equal(validateClaudeRequiredToolResult(request, response, []).code, 'TOOL_RESULT_MISSING');
  assert.equal(validateClaudeRequiredToolResult(request, response, [{ tool_use_id: 'tool-1', content: { ok: false } }]).code, 'DOMAIN_VALIDATION_FAILED');
  assert.equal(validateClaudeRequiredToolResult(request, response, [{ tool_use_id: 'tool-1', content: { ok: true } }]).status, 'compatible-settings');
  const structured = { ...request, tools: [], structuredOutput: true,
    requiredTool: { ...requiredTool, alternative: 'structured-output' } };
  assert.equal(guardClaudeModelRequest(structured).status, 'compatible-settings');
  assert.equal(validateClaudeRequiredToolResult(structured, { content: [{ type: 'text', text: '{"ok":true}' }] }, []).code, 'REQUIRED_TOOL_MISSING');
});

test('M04 leaves older model request settings unchanged', () => {
  assert.equal(guardClaudeModelRequest({ ...base, modelId: 'claude-opus-5', nativeControl: { kind: 'toggle', enabled: false },
    thinking: { type: 'disabled' }, toolChoice: { type: 'tool', name: 'lookup' } }).status, 'legacy-unmodified');
});
