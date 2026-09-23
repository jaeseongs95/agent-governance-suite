import preset from '../references/model-catalog/role-presets/opus55-balanced.v1.json' with { type: 'json' };
import { assert, keys, validateRequest } from './model-routing-core.mjs';

const EFFORT_ROLES = ['general-implementation', 'complex-reasoning', 'independent-audit'];

export function validateOpus55RolePresetV1(value) {
  keys(value, ['schemaVersion', 'presetId', 'origin', 'profile', 'defaultPreference',
    'selectableAlternative', 'effortCandidates', 'defaults']);
  assert(value.schemaVersion === '1.0.0' && value.presetId === 'opus55-balanced'
    && value.origin === 'anthropic' && value.profile === 'balanced', 'INVALID_PRESET');
  keys(value.defaultPreference, ['strength', 'model']);
  assert(value.defaultPreference.strength === 'preferred'
    && value.defaultPreference.model === 'claude-opus-5-5', 'INVALID_PRESET');
  keys(value.selectableAlternative, ['model', 'conditions']);
  assert(value.selectableAlternative.model === 'claude-fable-5-1'
    && Array.isArray(value.selectableAlternative.conditions)
    && value.selectableAlternative.conditions.length === 4
    && ['explicit-request', 'demanding-reasoning', 'long-horizon', 'specialized-work']
      .every(condition => value.selectableAlternative.conditions.includes(condition)), 'INVALID_PRESET');
  keys(value.effortCandidates, EFFORT_ROLES);
  assert(value.effortCandidates['general-implementation'] === 'medium'
    && value.effortCandidates['complex-reasoning'] === 'high'
    && value.effortCandidates['independent-audit'] === 'high', 'INVALID_PRESET');
  keys(value.defaults, ['max', 'fast', 'automaticPaidApiFallback']);
  assert(Object.values(value.defaults).every(setting => setting === false), 'INVALID_PRESET');
  return structuredClone(value);
}

const PRESET = validateOpus55RolePresetV1(preset);
Object.freeze(PRESET.defaultPreference);
Object.freeze(PRESET.selectableAlternative.conditions);
Object.freeze(PRESET.selectableAlternative);
Object.freeze(PRESET.effortCandidates);
Object.freeze(PRESET.defaults);
Object.freeze(PRESET);

/** Advisory only. M08 must supply the current server-derived eligible candidate set. */
export function readOpus55RolePresetV1() { return structuredClone(PRESET); }

/** Projects only into the existing v2 request preference field; never authorizes dispatch. */
export function projectOpus55RolePresetV1({ request, currentEligibleCandidates }) {
  validateRequest(request);
  assert(Array.isArray(currentEligibleCandidates) && currentEligibleCandidates.length <= 256
    && currentEligibleCandidates.every(candidate => typeof candidate?.model?.id === 'string'
      && typeof candidate.model.modelOrigin === 'string'), 'INVALID_INPUT',
  'Current eligible candidates are required');
  const unchanged = reason => ({ disposition: 'not-applied', reason,
    request: structuredClone(request), executionAuthorized: false });
  if (request.user) return unchanged('EXPLICIT_USER_PREFERENCE');
  if ((request.profile ?? 'balanced') !== 'balanced') return unchanged('PROFILE_NOT_BALANCED');
  if (currentEligibleCandidates.length === 0) return { disposition: 'defer',
    reason: 'NO_ELIGIBLE_CANDIDATE', request: structuredClone(request), executionAuthorized: false };
  if (currentEligibleCandidates.some(candidate => candidate.model.modelOrigin !== 'anthropic'))
    return unchanged('NOT_ANTHROPIC_ONLY');
  const roleEffort = PRESET.effortCandidates[request.role];
  if (!roleEffort) return unchanged('ROLE_NOT_COVERED');
  if (!currentEligibleCandidates.some(candidate => candidate.model.id === PRESET.defaultPreference.model))
    return { disposition: 'defer', reason: 'DEFAULT_MODEL_UNAVAILABLE',
      request: structuredClone(request), executionAuthorized: false };
  const projected = structuredClone(request);
  projected.user = structuredClone(PRESET.defaultPreference);
  validateRequest(projected);
  return { disposition: 'applied', reason: 'ANTHROPIC_BALANCED_DEFAULT', request: projected,
    effortCandidate: request.highRisk ? 'high' : roleEffort,
    alternativeModel: PRESET.selectableAlternative.model,
    executionAuthorized: false };
}
