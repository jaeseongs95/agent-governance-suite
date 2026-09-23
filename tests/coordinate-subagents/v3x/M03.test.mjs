import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { resolveV2, validateRequest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectOpus55RolePresetV1, readOpus55RolePresetV1,
  validateOpus55RolePresetV1 } from '../../../skills/coordinate-subagents/scripts/opus55-role-preset.mjs';
import { environment, request } from '../model-routing-v2/fixtures.mjs';

const candidate = (id, origin = 'anthropic') => ({ model: { id, modelOrigin: origin } });
const anthropic = [candidate('claude-opus-5-5'), candidate('claude-fable-5-1')];
const project = (req = request(), candidates = anthropic) =>
  projectOpus55RolePresetV1({ request: req, currentEligibleCandidates: candidates });

test('M03 validates a versioned, defensive Anthropic preset without enabling premium defaults', () => {
  const preset = readOpus55RolePresetV1();
  assert.equal(preset.defaultPreference.model, 'claude-opus-5-5');
  assert.equal(preset.defaultPreference.strength, 'preferred');
  assert.equal(preset.selectableAlternative.model, 'claude-fable-5-1');
  assert.deepEqual(preset.effortCandidates, {
    'general-implementation': 'medium', 'complex-reasoning': 'high', 'independent-audit': 'high',
  });
  assert.deepEqual(preset.defaults, { max: false, fast: false, automaticPaidApiFallback: false });
  preset.defaultPreference.model = 'changed';
  assert.equal(readOpus55RolePresetV1().defaultPreference.model, 'claude-opus-5-5');
  const invalid = readOpus55RolePresetV1();
  invalid.defaults.fast = true;
  assert.throws(() => validateOpus55RolePresetV1(invalid), { code: 'INVALID_PRESET' });
});

test('M03 projects only a preferred model into eligible Anthropic balanced requests', () => {
  const original = request();
  const before = structuredClone(original);
  const policyPath = new URL('../../../skills/coordinate-subagents/references/model-catalog/policy.json', import.meta.url);
  const policyBytes = readFileSync(policyPath);
  const result = project(original);
  assert.equal(result.disposition, 'applied');
  assert.deepEqual(result.request.user, { strength: 'preferred', model: 'claude-opus-5-5' });
  assert.equal(result.effortCandidate, 'medium');
  assert.equal(result.alternativeModel, 'claude-fable-5-1');
  assert.equal(result.executionAuthorized, false);
  assert.equal(Object.hasOwn(result.request.user, 'nativeReasoning'), false);
  assert.deepEqual(Object.keys(result.request).sort(), [...Object.keys(original), 'user'].sort());
  validateRequest(result.request);
  assert.deepEqual(original, before);
  assert.deepEqual(readFileSync(policyPath), policyBytes);
  assert.equal(project(request({ role: 'complex-reasoning' })).effortCandidate, 'high');
  const highRisk = project(request({ highRisk: true }));
  assert.equal(highRisk.effortCandidate, 'high');
  assert.equal(highRisk.request.highRisk, true);
  assert.equal(highRisk.request.user.nativeReasoning, undefined);
});

test('M03 preserves user choices and declines multi-vendor or unsupported defaults', () => {
  for (const strength of ['required', 'preferred']) {
    const req = request({ user: { strength, model: 'claude-fable-5-1' } });
    assert.deepEqual(project(req).request, req);
    assert.equal(project(req).reason, 'EXPLICIT_USER_PREFERENCE');
    const routed = resolveV2(project(req).request, environment());
    assert.equal(routed.status, strength === 'required' ? 'blocked' : 'selected');
    if (strength === 'preferred') assert.equal(routed.fallbackReason, 'PREFERRED_CHOICE_UNAVAILABLE');
  }
  assert.equal(project(request(), [candidate('claude-opus-5-5'), candidate('gpt-6-astra', 'openai')])
    .reason, 'NOT_ANTHROPIC_ONLY');
  assert.equal(project(request(), [candidate('claude-fable-5-1')]).reason, 'DEFAULT_MODEL_UNAVAILABLE');
  assert.equal(project(request(), []).reason, 'NO_ELIGIBLE_CANDIDATE');
  assert.equal(project(request({ profile: 'quality' })).reason, 'PROFILE_NOT_BALANCED');
  assert.equal(project(request({ role: 'discovery' })).reason, 'ROLE_NOT_COVERED');
  for (const candidates of [[candidate('claude-fable-5-1')], []]) {
    assert.equal(project(request(), candidates).executionAuthorized, false);
    assert.equal(project(request(), candidates).request.user, undefined);
  }
});
