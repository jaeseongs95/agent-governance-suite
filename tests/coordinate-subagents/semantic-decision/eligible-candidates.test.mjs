import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { test, vi } from 'vitest';
import {
  canonical, digest, seal, resolveV2,
  collectEligibleCandidatesV2, rankBaselineCandidatesV2,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { NOW, END, request, capability, environment } from '../model-routing-v2/fixtures.mjs';

const goldenBytes = readFileSync(new URL('./fixtures/v2-golden.json', import.meta.url));
const golden = JSON.parse(goldenBytes);
const selectionKeys = ['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath', 'nativeReasoning', 'runtimeMode'];
const targetKeys = ['actorId', 'host', 'sessionId', 'instanceId'];
const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
function reseal(env) {
  env.catalog = seal(env.catalog, 'catalogDigest');
  env.capabilities = env.capabilities.map(snapshot => seal(snapshot, 'snapshotDigest'));
  return env;
}
function multiEnvironment() {
  return environment({ capabilities: [
    capability({ actorId: 'a-sol', sessionId: 's-sol', instanceId: 'i-sol' }, { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
    capability({ actorId: 'a-terra', sessionId: 's-terra', instanceId: 'i-terra' }),
    capability({ actorId: 'a-sonnet', sessionId: 's-sonnet', instanceId: 'i-sonnet', host: 'anthropic-claude-code' }, {
      model: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', modelOrigin: 'anthropic', servingProvider: 'anthropic',
    }),
  ] });
}
function ordered(req, env) {
  return rankBaselineCandidatesV2(collectEligibleCandidatesV2(req, env).candidates, req, env);
}

// Independent oracle: never regenerate these expectations from the refactored functions.
test('S1b does not edit the fixed pre-S1a golden bytes', () => {
  assert.equal(createHash('sha256').update(goldenBytes).digest('hex'), '6e6ab050a229b4ae9aeb2e767722f69498a873bed02a3854c4e351c13749d54f');
});
for (const entry of golden.cases) test(`pure projections match the immutable v2 oracle: ${entry.name}`, () => {
  const req = freeze(structuredClone(entry.request));
  const env = freeze({ ...structuredClone(golden.environment), ...structuredClone(entry.environmentPatch) });
  const pool = collectEligibleCandidatesV2(req, env);
  assert.deepEqual(pool.rejectedCandidates, entry.expected.rejectedCandidates);
  assert.equal(pool.capabilitySetDigest, entry.expected.capabilitySetDigest);
  const first = rankBaselineCandidatesV2(freeze(pool.candidates), req, env)[0];
  assert.deepEqual(first ? pick(first.binding, selectionKeys) : null, entry.expected.selected);
  assert.deepEqual(first ? pick(first.snapshot, targetKeys) : null, entry.expected.target);
  assert.equal(first?.snapshot.snapshotDigest ?? null, entry.expected.capabilitySnapshotDigest);
  assert.equal(first?.binding.invocationSurface ?? null, entry.expected.invocationSurface);
  const decision = resolveV2(req, env);
  assert.equal(JSON.stringify(decision), JSON.stringify(entry.expected));
  assert.equal(canonical(decision), entry.expectedCanonical);
  assert.equal(decision.decisionDigest, entry.expected.decisionDigest);
});

const exclusions = [
  ['UNRESOLVED_MODEL', (_req, env, b) => { b.model = b.resolvedModel = 'missing-model'; }],
  ['ORIGIN_EXCLUDED', (_req, _env, b) => { b.modelOrigin = 'deepseek'; }],
  ['ORIGIN_MISMATCH', (_req, _env, b) => { b.modelOrigin = 'anthropic'; }],
  ['ALIAS_UNVERIFIED', (_req, _env, b) => { b.model = 'unproven-alias'; }],
  ['FALLBACK_ORIGIN_UNVERIFIED', (_req, _env, b) => { b.possibleFallbacks = [{ resolvedModel: 'missing-proxy', modelOrigin: 'deepseek' }]; }],
  ['FALLBACK_NOT_PINNED', (req, _env, b) => { req.highRisk = true; b.possibleFallbacks = [{ resolvedModel: 'gpt-5.6-terra', modelOrigin: 'openai' }]; }],
  ['HOST_DISABLED', (_req, env) => { env.policy.enabledHosts = []; }],
  ['RUNTIME_NOT_ENABLED', (_req, env) => { env.catalog.hosts.find(h => h.id === 'openai-codex').autoDispatch = false; }],
  ['CAPABILITY_EXPIRED', (_req, env) => { env.now = END; }],
  ['CATALOG_STALE', (_req, env) => { env.catalog.snapshotDate = '2026-07-01T00:00:00.000Z'; }],
  ['MODEL_STATUS_BLOCKED', (_req, env) => { env.catalog.models.find(m => m.id === 'gpt-5.6-terra').status = 'retired'; }],
  ['TASK_NOT_SUITABLE', (_req, env) => { env.catalog.models.find(m => m.id === 'gpt-5.6-terra').roles = []; }],
  ['CONTROL_NOT_SUPPORTED', (_req, env) => { env.catalog.models.find(m => m.id === 'gpt-5.6-terra').nativeKinds = []; }],
  ['MODEL_MINIMUM_NOT_MET', (_req, env) => { env.policy.modelMinimums.push({ model: 'gpt-5.6-terra', enumValues: ['max'] }); }],
  ['ACCESS_PATH_NOT_APPROVED', (_req, _env, b) => { b.accessPath = 'api'; }],
  ['EXECUTION_BOUNDARY_UNKNOWN', (_req, env) => { env.capabilities[0].executionCapabilities.approvals = 'unknown'; }],
  ['SURFACE_NOT_ALLOWED', req => { req.requirements.allowedSurfaces = ['headless']; }],
  ['INPUT_NOT_SUPPORTED', req => { req.requirements.inputModalities = ['video']; }],
  ['TOOLS_NOT_SUPPORTED', req => { req.requirements.tools = ['unavailable-tool']; }],
  ['FILESYSTEM_NOT_SUPPORTED', (_req, env) => { env.capabilities[0].executionCapabilities.filesystem = 'none'; }],
  ['RUNTIME_MODE_NOT_ALLOWED', (_req, _env, b) => { b.runtimeMode = 'ultra'; }],
  ['NESTED_DELEGATION_FORBIDDEN', (req, _env, b) => { req.requirements.allowedRuntimeModes.push('ultra'); b.runtimeMode = 'ultra'; }],
  ['OBSERVABILITY_INSUFFICIENT', (req, _env, b) => { req.requirements.requireObservable = ['reasoning']; b.observableFields = ['model']; }],
  ['INDEPENDENCE_CONFLICT', req => { req.requirements.excludedActors = ['actor-1']; }],
  ['HIGH_RISK_FLOOR_UNPROVEN', (req, env) => { req.highRisk = true; env.capabilities[0].source = 'configuration'; }],
  ['FULL_HISTORY_REQUIRES_LEGACY_INHERITANCE', req => { req.requirements.contextMode = 'full-history'; }],
  ['REQUIRED_CHOICE_UNAVAILABLE', req => { req.user = { strength: 'required', model: 'missing-model' }; }],
];
for (const [reason, change] of exclusions) test(`hard filter retains ${reason} before ranking`, () => {
  const req = request(), env = environment();
  change(req, env, env.capabilities[0].supportedBindings[0]);
  reseal(env);
  const pool = collectEligibleCandidatesV2(freeze(req), freeze(env));
  assert.equal(pool.candidates.length, 0);
  assert.equal(pool.rejectedCandidates.length, 1);
  const codes = pool.rejectedCandidates[0].reasonCodes;
  assert.ok(codes.includes(reason));
  assert.deepEqual(codes, [...new Set(codes)].sort());
  assert.deepEqual(rankBaselineCandidatesV2(pool.candidates, req, env), []);
});

test('collector and ranker do not mutate frozen inputs or alias their returned data to inputs', () => {
  const req = freeze(request()), env = freeze(multiEnvironment());
  const before = canonical({ req, env });
  const pool = collectEligibleCandidatesV2(req, env);
  const poolBefore = canonical(pool);
  const ranked = rankBaselineCandidatesV2(freeze(pool.candidates), req, env);
  ranked[0].binding.nativeReasoning.value = 'mutated-output';
  ranked[0].snapshot.actorId = 'mutated-output';
  ranked[0].model.roles.length = 0;
  ranked.reverse();
  assert.equal(canonical(pool), poolBefore);
  const otherPool = collectEligibleCandidatesV2(req, env);
  otherPool.candidates[0].snapshot.executionCapabilities.tools.push('mutated-output');
  otherPool.candidates[0].binding.runtimeMode = 'mutated-output';
  otherPool.candidates[0].model.aliases.push('mutated-output');
  assert.equal(canonical({ req, env }), before);
  assert.deepEqual(collectEligibleCandidatesV2(req, env), pool);
});

test('snapshot-order and candidate-order permutations do not change either pure projection', () => {
  const req = request(), env = multiEnvironment();
  const first = collectEligibleCandidatesV2(req, env);
  const reversed = collectEligibleCandidatesV2(req, { ...env, capabilities: [...env.capabilities].reverse() });
  assert.deepEqual(reversed, first);
  assert.deepEqual(first.candidates.map(c => c.key), first.candidates.map(c => c.key).sort());
  assert.deepEqual(rankBaselineCandidatesV2([...first.candidates].reverse(), req, env), ordered(req, env));
});

test('all exact bindings survive: no model-level collapse or host/control/runtime synthesis', () => {
  const req = request();
  req.requirements.allowedRuntimeModes.push('ultra');
  req.requirements.allowNestedDelegation = true;
  const base = capability();
  base.supportedBindings = ['high', 'medium'].flatMap(value => ['standard', 'ultra'].map(runtimeMode => ({
    ...structuredClone(base.supportedBindings[0]), nativeReasoning: { kind: 'enum', value }, runtimeMode,
  })));
  const a = seal(base, 'snapshotDigest');
  const b = seal({ ...base, actorId: 'actor-2', sessionId: 'session-2', instanceId: 'instance-2' }, 'snapshotDigest');
  const env = environment({ capabilities: [a, b] });
  const pool = collectEligibleCandidatesV2(req, env);
  assert.equal(pool.candidates.length, 8);
  assert.equal(new Set(pool.candidates.map(c => c.key)).size, 8);
  for (const c of ordered(req, env)) {
    const snapshot = env.capabilities.find(s => s.snapshotDigest === c.snapshot.snapshotDigest);
    assert.deepEqual(c.snapshot, snapshot);
    assert.ok(snapshot.supportedBindings.some(binding => canonical(binding) === canonical(c.binding)));
    assert.equal(c.key, digest({ snapshotDigest: snapshot.snapshotDigest, binding: c.binding }));
    assert.equal(c.model.id, c.binding.resolvedModel);
  }
  const decision = resolveV2(req, env);
  assert.equal(decision.binding.candidateDigest, req.binding.candidateDigest);
  assert.equal(decision.executionAuthorized, false);
  assert.equal(decision.trustedGateSatisfied, false);
});

test('capability set digest includes valid-but-expired or rejected snapshots, not malformed ones', () => {
  const good = capability();
  const expired = capability({ observedAt: '2026-09-21T11:55:00.000Z', expiresAt: NOW, sessionId: 'expired' });
  const bad = { ...good, source: 'agent-self-report' };
  const env = environment({ capabilities: [bad, expired, good] });
  const pool = collectEligibleCandidatesV2(request(), env);
  assert.equal(pool.candidates.length, 1);
  assert.equal(pool.capabilitySetDigest, digest([good.snapshotDigest, expired.snapshotDigest].sort()));
  assert.deepEqual(pool.rejectedCandidates.find(c => c.candidateKey === `invalid:${digest(bad)}`).reasonCodes, ['INVALID_INPUT']);
  assert.ok(pool.rejectedCandidates.some(c => c.reasonCodes.includes('CAPABILITY_EXPIRED')));
});

test('snapshot binding order remains part of snapshot identity rather than being normalized away', () => {
  const a = capability();
  a.supportedBindings.push({ ...a.supportedBindings[0], nativeReasoning: { kind: 'enum', value: 'medium' } });
  const forward = seal(a, 'snapshotDigest');
  const reverse = seal({ ...a, supportedBindings: [...a.supportedBindings].reverse() }, 'snapshotDigest');
  const first = collectEligibleCandidatesV2(request(), environment({ capabilities: [forward] }));
  const second = collectEligibleCandidatesV2(request(), environment({ capabilities: [reverse] }));
  assert.notEqual(first.capabilitySetDigest, second.capabilitySetDigest);
  assert.notEqual(first.candidates[0].key, second.candidates[0].key);
  assert.equal(first.candidates.length, second.candidates.length);
});

test('empty and zero-binding valid snapshots preserve the existing digest definition', () => {
  const empty = collectEligibleCandidatesV2(request(), environment({ capabilities: [] }));
  assert.deepEqual(empty, { candidates: [], rejectedCandidates: [], capabilitySetDigest: digest([]) });
  const c = capability({ supportedBindings: [] });
  const noBindings = collectEligibleCandidatesV2(request(), environment({ capabilities: [c] }));
  assert.deepEqual(noBindings, { candidates: [], rejectedCandidates: [], capabilitySetDigest: digest([c.snapshotDigest]) });
});
for (const [name, make] of [
  ['duplicate snapshots', () => { const env = environment(); env.capabilities.push(env.capabilities[0]); return env; }],
  ['oversized snapshot list', () => environment({ capabilities: Array(257).fill(capability()) })],
  ['non-array snapshot list', () => environment({ capabilities: {} })],
  ['invalid time', () => environment({ now: 'not-a-time' })],
]) test(`collector preserves input rejection: ${name}`, () => {
  assert.throws(() => collectEligibleCandidatesV2(request(), make()), e => e.code === 'INVALID_INPUT');
});

test('collector does not suppress malformed non-JSON snapshot failures', () => {
  assert.throws(() => collectEligibleCandidatesV2(request(), environment({ capabilities: [undefined] })), e => e.code === 'INVALID_INPUT');
});

test('preference group outranks task, profile, and native-control ordering', () => {
  const env = multiEnvironment(), req = request({ user: { strength: 'preferred', model: 'claude-sonnet-5' }, profile: 'quality' });
  const candidates = ordered(req, env);
  assert.deepEqual(candidates.map(c => c.model.id), ['claude-sonnet-5', 'gpt-5.6-sol', 'gpt-5.6-terra']);
});

test('required group is a hard filter, not just a ranking boost', () => {
  const env = multiEnvironment(), req = request({ user: { strength: 'required', model: 'claude-sonnet-5' } });
  const pool = collectEligibleCandidatesV2(req, env);
  assert.deepEqual(pool.candidates.map(c => c.model.id), ['claude-sonnet-5']);
  assert.equal(pool.rejectedCandidates.length, 2);
  assert.ok(pool.rejectedCandidates.every(c => c.reasonCodes.includes('REQUIRED_CHOICE_UNAVAILABLE')));
});

test('an unavailable preferred group falls back only within the eligible set', () => {
  const req = request({ user: { strength: 'preferred', model: 'missing-model' } }), env = multiEnvironment();
  assert.equal(ordered(req, env)[0].model.id, 'gpt-5.6-sol');
  assert.equal(resolveV2(req, env).fallbackReason, 'PREFERRED_CHOICE_UNAVAILABLE');
});

test('task ordering precedes profile; absent task ordering uses profile', () => {
  const env = multiEnvironment();
  assert.equal(ordered(request(), env)[0].model.id, 'gpt-5.6-sol');
  assert.equal(ordered(request({ taskTraits: [] }), env)[0].model.id, 'gpt-5.6-terra');
  assert.equal(ordered(request({ taskTraits: [], profile: 'quality' }), env)[0].model.id, 'gpt-5.6-sol');
});

test('task trait order is sorted and deduplicated before the legacy model ranking', () => {
  const env = multiEnvironment();
  env.policy.traitOrder['architecture-decision'] = ['claude-sonnet-5', 'gpt-5.6-sol'];
  env.policy.traitOrder['code-change'] = ['gpt-5.6-sol', 'gpt-5.6-terra'];
  const a = request({ taskTraits: ['code-change', 'architecture-decision'] });
  const b = request({ taskTraits: ['architecture-decision', 'code-change'] });
  assert.equal(ordered(a, env)[0].model.id, 'claude-sonnet-5');
  assert.deepEqual(ordered(a, env), ordered(b, env));
});

test('omitting profile uses balanced without editing the request', () => {
  const req = request(), env = multiEnvironment();
  delete req.profile;
  assert.deepEqual(ordered(freeze(req), env), ordered(request(), env));
  assert.equal(Object.hasOwn(req, 'profile'), false);
});

for (const [profile, expected] of [['economy', 'medium'], ['balanced', 'high'], ['quality', 'high']]) {
  test(`native control ordering is preserved for ${profile}`, () => {
    const c = capability();
    c.supportedBindings.push({ ...c.supportedBindings[0], nativeReasoning: { kind: 'enum', value: 'medium' } });
    const env = environment({ capabilities: [seal(c, 'snapshotDigest')] });
    assert.equal(ordered(request({ profile }), env)[0].binding.nativeReasoning.value, expected);
  });
}

test('unknown native control sorts after reviewed controls but is not rewritten', () => {
  const c = capability();
  c.supportedBindings.unshift({ ...c.supportedBindings[0], nativeReasoning: { kind: 'enum', value: 'vendor-specific' } });
  const env = environment({ capabilities: [seal(c, 'snapshotDigest')] });
  const candidates = ordered(request(), env);
  assert.deepEqual(candidates.map(c => c.binding.nativeReasoning.value), ['high', 'vendor-specific']);
});

test('full baseline ties use candidate key, including an absent host control-order rule', () => {
  const req = request(), env = environment({ capabilities: [capability({ sessionId: 'z' }), capability({ sessionId: 'a' }), capability({ sessionId: 'm' })] });
  env.policy.controlOrder = [];
  const pool = collectEligibleCandidatesV2(req, env);
  assert.deepEqual(ordered(req, env).map(c => c.key), pool.candidates.map(c => c.key).sort());
});

test('preferred native control never creates a new binding or outranks high-risk rejection', () => {
  const req = request({ user: { strength: 'preferred', nativeReasoning: { kind: 'enum', value: 'low' } }, highRisk: true });
  const c = capability();
  c.supportedBindings.push({ ...c.supportedBindings[0], nativeReasoning: { kind: 'enum', value: 'low' } });
  const env = environment({ capabilities: [seal(c, 'snapshotDigest')] });
  assert.equal(ordered(req, env)[0].binding.nativeReasoning.value, 'high');
  assert.equal(resolveV2(req, env).fallbackReason, 'PREFERRED_CHOICE_UNAVAILABLE');
});

test('preference resolves documented aliases but retains the exact advertised native binding', () => {
  const req = request({ user: { strength: 'preferred', model: 'sonnet', host: 'anthropic-claude-code' } }), env = multiEnvironment();
  const winner = ordered(req, env)[0];
  assert.equal(winner.model.id, 'claude-sonnet-5');
  assert.equal(winner.binding.model, 'claude-sonnet-5');
  assert.equal(winner.snapshot.host, 'anthropic-claude-code');
});

test('only supplied time is used and an explicit expiry change requires fresh collection', () => {
  const req = request(), env = environment();
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Implicit wall-clock read'); });
  try {
    assert.equal(ordered(req, env).length, 1);
    assert.equal(ordered(req, { ...env, now: END }).length, 0);
  } finally { spy.mockRestore(); }
});

test('pure helper declarations preserve concrete candidate/binding types and readonly array input', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const virtual = path.join(root, 'contracts', '__eligible_candidates_virtual.ts');
  const source = `
    import { collectEligibleCandidatesV2, getBaselineCandidateMetadataV2, rankBaselineCandidatesV2, type EligibleCandidateV2, type RoutingEnvironmentV2 } from '../skills/coordinate-subagents/scripts/model-routing-core.mjs';
    import type { ModelSelectionRequestV2, ModelRoutingDecisionV2, HostModelCapabilitiesV1, ModelCatalogV1 } from './model-routing-types.js';
    declare const req: ModelSelectionRequestV2;
    declare const env: RoutingEnvironmentV2;
    const pool = collectEligibleCandidatesV2(req, env);
    const readonlyCandidates: readonly EligibleCandidateV2[] = pool.candidates;
    const result: EligibleCandidateV2[] = rankBaselineCandidatesV2(readonlyCandidates, req, env);
    const metadata = getBaselineCandidateMetadataV2(readonlyCandidates, req, env);
    const rank: number = metadata[0]!.baselineRank;
    const binding: HostModelCapabilitiesV1['supportedBindings'][number] = result[0]!.binding;
    const model: ModelCatalogV1['models'][number] = result[0]!.model;
    const rejected: ModelRoutingDecisionV2['rejectedCandidates'] = pool.rejectedCandidates;
    // @ts-expect-error A model name is not a native host binding.
    const broken: EligibleCandidateV2 = { key: 'x', model, snapshot: env.capabilities[0]!, binding: 'model-only' };
    // @ts-expect-error Ranking accepts candidates, not model IDs.
    rankBaselineCandidatesV2(['model-only'], req, env);
    // @ts-expect-error A candidate projection grants no execution authority.
    const authority: true = pool.executionAuthorized;
    // @ts-expect-error Baseline metadata grants no execution authority.
    const metadataAuthority: true = metadata[0]!.executionAuthorized;
  `;
  const options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true, skipLibCheck: true, types: [] };
  const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  host.fileExists = file => path.normalize(file) === virtual || originalFileExists(file);
  host.getSourceFile = (file, version, onError, shouldCreate) => path.normalize(file) === virtual
    ? ts.createSourceFile(file, source, version, true) : original(file, version, onError, shouldCreate);
  const program = ts.createProgram([virtual], options, host);
  const errors = ts.getPreEmitDiagnostics(program).filter(item => item.category === ts.DiagnosticCategory.Error);
  assert.deepEqual(errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, '\n')), []);
});
