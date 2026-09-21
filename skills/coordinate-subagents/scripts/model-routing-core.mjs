/** AGS v2 routing: pure selection and diagnostic evidence, never execution authority. */
import { createHash } from 'node:crypto';

export const ROLES = Object.freeze(['discovery', 'general-implementation', 'complex-reasoning', 'independent-audit']);
export const ORIGINS = Object.freeze(['openai', 'anthropic', 'google', 'xai', 'mistral', 'amazon', 'cohere', 'meta']);
export const TRAITS = Object.freeze(['architecture-decision', 'code-change', 'diagnosis', 'source-research', 'google-app-operation', 'context-repair', 'multimodal-input']);
const CLASSES = ['lightweight', 'general', 'deep', 'frontier'];
const SOURCES = ['configuration', 'tool-contract', 'host-observation', 'live-probe'];
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const BIND_KEYS = ['assignmentId', 'taskId', 'runId', 'stageId', 'attemptId', 'revision', 'inputDigest', 'candidateDigest'];
const TARGET_KEYS = ['actorId', 'host', 'sessionId', 'instanceId'];

export class RoutingError extends Error {
  constructor(code, message) { super(message); this.name = 'RoutingError'; this.code = code; }
}
export function assert(condition, code, message = code) { if (!condition) throw new RoutingError(code, message); }
export function object(value, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, 'INVALID_INPUT', `${name} must be a plain JSON object`);
  return value;
}
export function keys(value, allowed, required = allowed, name = 'object') {
  object(value, name);
  assert(Object.keys(value).every(k => allowed.includes(k)), 'INVALID_INPUT', `${name}: unexpected field`);
  assert(required.every(k => Object.hasOwn(value, k)), 'INVALID_INPUT', `${name}: required field missing`);
}
export function text(value, name, maximum = 512) {
  assert(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= maximum && !value.includes('\0'), 'INVALID_INPUT', `${name}: non-empty bounded string required`);
}
export function identifier(value, name) { assert(typeof value === 'string' && ID.test(value), 'INVALID_INPUT', `${name}: invalid identifier`); }
export function digestValue(value, name) { assert(typeof value === 'string' && DIGEST.test(value), 'INVALID_INPUT', `${name}: sha256 digest required`); }
export function instant(value, name) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, 'INVALID_INPUT', `${name}: canonical UTC timestamp required`);
  return Date.parse(value);
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) { assert(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `${name}: invalid integer`); }
function strings(value, name, allowed, maximum = 128) {
  assert(Array.isArray(value) && value.length <= maximum && value.every(v => typeof v === 'string' && (allowed ? allowed.includes(v) : v.length > 0 && v.length <= 200)) && new Set(value).size === value.length, 'INVALID_INPUT', `${name}: unique bounded array required`);
}
function bool(value, name) { assert(typeof value === 'boolean', 'INVALID_INPUT', `${name}: boolean required`); }

export function canonical(value) {
  const seen = new Set();
  const visit = (v) => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') { assert(Number.isFinite(v), 'INVALID_INPUT', 'Non-finite JSON number'); return JSON.stringify(v); }
    assert(v && typeof v === 'object' && !seen.has(v), 'INVALID_INPUT', 'Non-JSON or cyclic value');
    seen.add(v);
    let result;
    if (Array.isArray(v)) result = `[${Array.from(v, visit).join(',')}]`;
    else { object(v, 'canonical object'); result = `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${visit(v[k])}`).join(',')}}`; }
    seen.delete(v); return result;
  };
  return visit(value);
}
export function digest(value) { return `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`; }
export function seal(value, field) { const out = structuredClone(value); delete out[field]; return { ...out, [field]: digest(out) }; }
export function verifySeal(value, field) {
  digestValue(value[field], field);
  const content = { ...value }; delete content[field];
  assert(digest(content) === value[field], 'DIGEST_MISMATCH', `${field} does not match contents`);
}
export function validateBinding(binding) {
  keys(binding, BIND_KEYS);
  for (const k of BIND_KEYS.slice(0, 5)) identifier(binding[k], k);
  integer(binding.revision, 'revision'); digestValue(binding.inputDigest, 'inputDigest'); digestValue(binding.candidateDigest, 'candidateDigest');
  return binding;
}
export function validateTarget(target) { keys(target, TARGET_KEYS); for (const k of TARGET_KEYS) identifier(target[k], k); return target; }
export function validateReasoning(control) {
  object(control, 'nativeReasoning');
  if (control.kind === 'enum') { keys(control, ['kind', 'value']); identifier(control.value, 'reasoning enum'); assert(!['ultra', 'ultracode'].includes(control.value.toLowerCase()), 'RUNTIME_IS_NOT_EFFORT'); }
  else if (control.kind === 'token-budget') { keys(control, ['kind', 'budgetTokens']); integer(control.budgetTokens, 'budgetTokens', 1, 10_000_000); }
  else if (control.kind === 'toggle') { keys(control, ['kind', 'enabled']); bool(control.enabled, 'enabled'); }
  else { keys(control, ['kind']); assert(control.kind === 'not-exposed', 'INVALID_INPUT', 'Unknown native reasoning control'); }
  return control;
}
export function validateSelection(value) {
  keys(value, ['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath', 'nativeReasoning', 'runtimeMode']);
  for (const k of ['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'runtimeMode']) identifier(value[k], k);
  assert(['subscription', 'api', 'enterprise', 'unknown'].includes(value.accessPath), 'INVALID_INPUT', 'Invalid accessPath');
  validateReasoning(value.nativeReasoning); return value;
}

export function validateCapabilities(snapshot) {
  keys(snapshot, ['schemaVersion', 'host', 'hostVersion', 'adapterVersion', 'actorId', 'sessionId', 'instanceId', 'observedAt', 'expiresAt', 'supportedBindings', 'executionCapabilities', 'source', 'sourceReference', 'snapshotDigest']);
  assert(snapshot.schemaVersion === '1.0.0', 'INVALID_INPUT', 'HostModelCapabilities.v1 required');
  validateTarget(Object.fromEntries(TARGET_KEYS.map(k => [k, snapshot[k]])));
  text(snapshot.hostVersion, 'hostVersion'); text(snapshot.adapterVersion, 'adapterVersion');
  const start = instant(snapshot.observedAt, 'observedAt'), end = instant(snapshot.expiresAt, 'expiresAt');
  assert(end > start && end - start <= 86_400_000, 'INVALID_INPUT', 'Capability validity must be 0 < ttl <= 24h');
  assert(SOURCES.includes(snapshot.source), 'INVALID_INPUT', 'Agent self-report is not a capability source'); text(snapshot.sourceReference, 'sourceReference');
  const ex = snapshot.executionCapabilities;
  keys(ex, ['dispatch', 'observe', 'cancel', 'resume', 'filesystem', 'tools', 'approvals', 'isolation', 'inputModalities']);
  for (const k of ['dispatch', 'observe', 'cancel', 'resume']) assert([true, false, 'unknown'].includes(ex[k]), 'INVALID_INPUT', `Invalid ${k} capability`);
  assert(['none', 'read', 'write', 'unknown'].includes(ex.filesystem), 'INVALID_INPUT', 'Invalid filesystem capability');
  strings(ex.tools, 'tools'); strings(ex.inputModalities, 'inputModalities', ['text', 'image', 'audio', 'video']);
  assert(['enforced', 'unknown'].includes(ex.approvals), 'INVALID_INPUT', 'Invalid approval boundary');
  assert(['process', 'sandbox', 'remote', 'unknown'].includes(ex.isolation), 'INVALID_INPUT', 'Invalid isolation');
  assert(Array.isArray(snapshot.supportedBindings) && snapshot.supportedBindings.length <= 256, 'INVALID_INPUT', 'Invalid supported bindings');
  const seen = new Set();
  for (const binding of snapshot.supportedBindings) {
    keys(binding, ['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath', 'nativeReasoning', 'runtimeMode', 'invocationSurface', 'observableFields', 'aliasResolution', 'possibleFallbacks']);
    validateSelection(Object.fromEntries(['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath', 'nativeReasoning', 'runtimeMode'].map(k => [k, binding[k]])));
    assert(['local-subagent', 'peer-session', 'headless'].includes(binding.invocationSurface), 'INVALID_INPUT', 'Invalid invocationSurface');
    strings(binding.observableFields, 'observableFields', ['model', 'reasoning', 'runtimeMode']);
    if (binding.aliasResolution !== null) {
      keys(binding.aliasResolution, ['alias', 'resolvedModel', 'sourceReference']);
      identifier(binding.aliasResolution.alias, 'alias'); identifier(binding.aliasResolution.resolvedModel, 'resolvedModel'); text(binding.aliasResolution.sourceReference, 'alias evidence');
      assert(binding.aliasResolution.alias === binding.model && binding.aliasResolution.resolvedModel === binding.resolvedModel, 'INVALID_INPUT', 'Alias resolution conflicts with binding');
    }
    assert(Array.isArray(binding.possibleFallbacks) && binding.possibleFallbacks.length <= 32, 'INVALID_INPUT');
    for (const f of binding.possibleFallbacks) { keys(f, ['resolvedModel', 'modelOrigin']); identifier(f.resolvedModel, 'fallback model'); identifier(f.modelOrigin, 'fallback origin'); }
    const key = digest(binding); assert(!seen.has(key), 'INVALID_INPUT', 'Duplicate binding'); seen.add(key);
  }
  verifySeal(snapshot, 'snapshotDigest'); return snapshot;
}

export function validatePolicy(policy) {
  keys(policy, ['schemaVersion', 'allowedOrigins', 'enabledHosts', 'allowedAccessPaths', 'allowPreview', 'allowSeedModels', 'maxCatalogAgeDays', 'profileOrder', 'traitOrder', 'controlOrder', 'modelMinimums', 'highRiskNativeFloor', 'fullHistoryInheritanceHosts']);
  assert(policy.schemaVersion === '1.0.0', 'INVALID_INPUT');
  strings(policy.allowedOrigins, 'allowedOrigins', ORIGINS); strings(policy.enabledHosts, 'enabledHosts');
  strings(policy.allowedAccessPaths, 'allowedAccessPaths', ['subscription', 'api', 'enterprise']);
  bool(policy.allowPreview, 'allowPreview'); bool(policy.allowSeedModels, 'allowSeedModels'); integer(policy.maxCatalogAgeDays, 'maxCatalogAgeDays', 1, 366);
  keys(policy.profileOrder, ['economy', 'balanced', 'quality']);
  for (const profile of Object.values(policy.profileOrder)) { keys(profile, ROLES); for (const v of Object.values(profile)) strings(v, 'model order'); }
  keys(policy.traitOrder, TRAITS, []); for (const v of Object.values(policy.traitOrder)) strings(v, 'trait order');
  assert(Array.isArray(policy.controlOrder) && policy.controlOrder.length <= 256, 'INVALID_INPUT');
  const seen = new Set();
  for (const rule of policy.controlOrder) {
    keys(rule, ['host', 'role', 'profile', 'controls']); identifier(rule.host, 'control host');
    assert(ROLES.includes(rule.role) && ['economy', 'balanced', 'quality'].includes(rule.profile), 'INVALID_INPUT');
    assert(Array.isArray(rule.controls) && rule.controls.length <= 32, 'INVALID_INPUT');
    for (const control of rule.controls) validateReasoning(control);
    const key = `${rule.host}/${rule.role}/${rule.profile}`; assert(!seen.has(key), 'INVALID_INPUT', 'Duplicate control order'); seen.add(key);
  }
  // Product-specific minimums and floors are reviewed policy data, never names in this shared engine.
  assert(Array.isArray(policy.modelMinimums) && policy.modelMinimums.length <= 256, 'INVALID_INPUT');
  const minimumModels = new Set();
  for (const rule of policy.modelMinimums) {
    keys(rule, ['model', 'enumValues']); identifier(rule.model, 'minimum model'); strings(rule.enumValues, 'minimum enumValues', null, 32);
    assert(rule.enumValues.length > 0 && !minimumModels.has(rule.model), 'INVALID_INPUT', 'Duplicate or empty model minimum'); minimumModels.add(rule.model);
  }
  assert(Array.isArray(policy.highRiskNativeFloor) && policy.highRiskNativeFloor.length <= 64, 'INVALID_INPUT');
  const floorHosts = new Set();
  for (const rule of policy.highRiskNativeFloor) {
    keys(rule, ['host', 'modelOrigins', 'minimumModelClass', 'enumValues']); identifier(rule.host, 'floor host');
    strings(rule.modelOrigins, 'floor modelOrigins', ORIGINS, 32); assert(CLASSES.includes(rule.minimumModelClass), 'INVALID_INPUT'); strings(rule.enumValues, 'floor enumValues', null, 32);
    assert(rule.modelOrigins.length > 0 && rule.enumValues.length > 0 && !floorHosts.has(rule.host), 'INVALID_INPUT', 'Duplicate or empty high-risk floor'); floorHosts.add(rule.host);
  }
  strings(policy.fullHistoryInheritanceHosts, 'fullHistoryInheritanceHosts', null, 64);
  return policy;
}
export function validateRequest(request) {
  keys(request, ['schemaVersion', 'binding', 'role', 'highRisk', 'profile', 'taskTraits', 'requirements', 'user'], ['schemaVersion', 'binding', 'role', 'highRisk', 'requirements']);
  assert(request.schemaVersion === '2.0.0', 'INVALID_INPUT', 'ModelSelectionRequest.v2 required'); validateBinding(request.binding);
  assert(ROLES.includes(request.role), 'INVALID_INPUT', 'Unknown role'); bool(request.highRisk, 'highRisk');
  assert(request.role !== 'independent-audit' || request.highRisk, 'INVALID_INPUT', 'Independent audit requires highRisk');
  assert(['economy', 'balanced', 'quality'].includes(request.profile ?? 'balanced'), 'INVALID_INPUT', 'Unknown profile'); strings(request.taskTraits ?? [], 'taskTraits', TRAITS);
  const req = request.requirements;
  keys(req, ['inputModalities', 'tools', 'filesystem', 'allowedSurfaces', 'allowedRuntimeModes', 'allowNestedDelegation', 'requireObservable', 'excludedActors', 'excludedSessions', 'contextMode'], ['inputModalities', 'tools', 'filesystem', 'allowedSurfaces', 'allowedRuntimeModes', 'allowNestedDelegation', 'requireObservable', 'excludedActors', 'excludedSessions', 'contextMode']);
  strings(req.inputModalities, 'inputModalities', ['text', 'image', 'audio', 'video']); strings(req.tools, 'tools');
  assert(['none', 'read', 'write'].includes(req.filesystem), 'INVALID_INPUT');
  strings(req.allowedSurfaces, 'allowedSurfaces', ['local-subagent', 'peer-session', 'headless']); strings(req.allowedRuntimeModes, 'allowedRuntimeModes');
  bool(req.allowNestedDelegation, 'allowNestedDelegation'); strings(req.requireObservable, 'requireObservable', ['model', 'reasoning', 'runtimeMode']);
  strings(req.excludedActors, 'excludedActors'); strings(req.excludedSessions, 'excludedSessions');
  assert(['limited', 'full-history'].includes(req.contextMode), 'INVALID_INPUT');
  if (request.user) {
    keys(request.user, ['strength', 'model', 'host', 'nativeReasoning', 'runtimeMode'], ['strength']);
    assert(['required', 'preferred'].includes(request.user.strength), 'INVALID_INPUT', 'Invalid preference strength');
    assert(Object.keys(request.user).length > 1, 'INVALID_INPUT', 'Empty preference');
    for (const k of ['model', 'host', 'runtimeMode']) if (Object.hasOwn(request.user, k)) identifier(request.user[k], k);
    if (request.user.nativeReasoning) validateReasoning(request.user.nativeReasoning);
  }
  return request;
}
export function validateCatalog(catalog) {
  keys(catalog, ['schemaVersion', 'snapshotDate', 'models', 'hosts', 'sources', 'catalogDigest']);
  assert(catalog.schemaVersion === '1.0.0', 'INVALID_INPUT'); instant(catalog.snapshotDate, 'snapshotDate');
  assert(Array.isArray(catalog.models) && catalog.models.length <= 512, 'INVALID_INPUT');
  assert(Array.isArray(catalog.hosts) && Array.isArray(catalog.sources), 'INVALID_INPUT');
  const sourceIds = new Set();
  for (const source of catalog.sources) { keys(source, ['id', 'url', 'checkedAt', 'evidenceKind', 'note']); identifier(source.id, 'source id'); assert(!sourceIds.has(source.id), 'INVALID_INPUT', 'Duplicate source'); sourceIds.add(source.id); text(source.url, 'source URL', 2048); assert(/^(?:https:\/\/|plan:|repository:)/u.test(source.url), 'INVALID_INPUT'); instant(source.checkedAt, 'checkedAt'); assert(['official-document', 'baseline-source', 'user-plan'].includes(source.evidenceKind), 'INVALID_INPUT'); text(source.note, 'source note', 4096); }
  const hosts = new Set();
  for (const host of catalog.hosts) {
    keys(host, ['id', 'defaultEnabled', 'autoDispatch', 'status', 'sourceIds', 'requiredCapabilities', 'unknownCapabilities']); identifier(host.id, 'host id'); assert(!hosts.has(host.id), 'INVALID_INPUT', 'Duplicate host'); hosts.add(host.id);
    bool(host.defaultEnabled, 'defaultEnabled'); bool(host.autoDispatch, 'autoDispatch'); assert(['baseline', 'experimental', 'descriptor-only'].includes(host.status), 'INVALID_INPUT');
    strings(host.sourceIds, 'sourceIds'); assert(host.sourceIds.length > 0 && host.sourceIds.every(s => sourceIds.has(s)), 'CATALOG_SOURCE_MISSING'); strings(host.requiredCapabilities, 'requiredCapabilities'); strings(host.unknownCapabilities, 'unknownCapabilities');
  }
  const ids = new Set(), aliases = new Set();
  for (const model of catalog.models) {
    keys(model, ['id', 'modelOrigin', 'aliases', 'modelClass', 'status', 'verification', 'roles', 'taskTraits', 'nativeKinds', 'inputModalities', 'contextTokens', 'abilityScore', 'officialPositioning', 'recommendationBasis', 'sourceIds', 'checkedAt']);
    identifier(model.id, 'model id'); assert(!ids.has(model.id), 'INVALID_INPUT', 'Duplicate model'); ids.add(model.id);
    assert(ORIGINS.includes(model.modelOrigin), 'ORIGIN_EXCLUDED', 'Catalog contains excluded origin');
    strings(model.aliases, 'aliases'); for (const alias of [model.id, ...model.aliases]) { assert(!aliases.has(alias), 'INVALID_INPUT', 'Conflicting model alias'); aliases.add(alias); }
    assert(CLASSES.includes(model.modelClass), 'INVALID_INPUT'); assert(['stable', 'preview', 'seed', 'retired'].includes(model.status), 'INVALID_INPUT');
    strings(model.verification, 'verification', ['documented', 'baseline-seed', 'contract-tested', 'live-verified', 'locally-evaluated']);
    strings(model.roles, 'roles', ROLES); strings(model.taskTraits, 'taskTraits', TRAITS); strings(model.nativeKinds, 'nativeKinds', ['enum', 'token-budget', 'toggle', 'not-exposed']);
    strings(model.inputModalities, 'inputModalities', ['text', 'image', 'audio', 'video']);
    if (model.contextTokens !== null) integer(model.contextTokens, 'contextTokens', 1);
    assert(model.abilityScore === null, 'INVALID_INPUT', 'No measured ability ranking is bundled');
    assert(model.officialPositioning === null || typeof model.officialPositioning === 'string', 'INVALID_INPUT'); text(model.recommendationBasis, 'recommendationBasis', 2048);
    strings(model.sourceIds, 'sourceIds'); assert(model.sourceIds.length > 0 && model.sourceIds.every(s => sourceIds.has(s)), 'CATALOG_SOURCE_MISSING'); instant(model.checkedAt, 'model checkedAt');
  }
  verifySeal(catalog, 'catalogDigest'); return catalog;
}
function catalogModel(catalog, name) { return catalog.models.find(m => m.id === name || m.aliases.includes(name)); }
function exactModel(catalog, name) { return catalog.models.find(m => m.id === name); }
function matchesPreference(candidate, pref, catalog) {
  if (!pref) return false;
  const m = pref.model ? catalogModel(catalog, pref.model) : null;
  return (!pref.model || m?.id === candidate.model?.id)
    && (!pref.host || pref.host === candidate.snapshot.host)
    && (!pref.runtimeMode || pref.runtimeMode === candidate.binding.runtimeMode)
    && (!pref.nativeReasoning || canonical(pref.nativeReasoning) === canonical(candidate.binding.nativeReasoning));
}
/** Reviewed v1 bridge: native enums on policy-listed hosts only. Does NOT satisfy the existing trusted gate. */
export function legacyFloor(binding, host, model, policy) {
  const rule = policy.highRiskNativeFloor.find(r => r.host === host);
  if (!rule || binding.nativeReasoning.kind !== 'enum' || binding.runtimeMode !== 'standard') return false;
  if (!model || CLASSES.indexOf(model.modelClass) < CLASSES.indexOf(rule.minimumModelClass)) return false;
  // A model without a native enum (for example a manual thinking budget) never reaches this point with kind 'enum'.
  if (!rule.modelOrigins.includes(model.modelOrigin) || !model.nativeKinds.includes('enum')) return false;
  return rule.enumValues.includes(binding.nativeReasoning.value);
}
function belowModelMinimum(binding, model, policy) {
  const rule = model && policy.modelMinimums.find(r => r.model === model.id);
  return Boolean(rule) && !(binding.nativeReasoning.kind === 'enum' && rule.enumValues.includes(binding.nativeReasoning.value));
}
function selectionFrom(binding) { return Object.fromEntries(['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath', 'nativeReasoning', 'runtimeMode'].map(k => [k, structuredClone(binding[k])])); }
function lexical(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** dependencies are caller-supplied *server owned* snapshots, not request authority. */
export function resolveV2(request, { catalog, policy, capabilities, now }) {
  validateRequest(request); validateCatalog(catalog); validatePolicy(policy);
  const nowMs = instant(now, 'now');
  assert(Array.isArray(capabilities) && capabilities.length <= 256, 'INVALID_INPUT', 'Capability list too large');
  const rejectedCandidates = [], candidates = [], validSnapshotDigests = [], seenSnapshots = new Set();
  const reject = (candidateKey, reasonCodes) => rejectedCandidates.push({ candidateKey, reasonCodes: [...new Set(reasonCodes)].sort() });
  for (const snapshot of capabilities) {
    try { validateCapabilities(snapshot); } catch (error) { reject(`invalid:${digest(snapshot)}`, [error.code ?? 'INVALID_CAPABILITY']); continue; }
    assert(!seenSnapshots.has(snapshot.snapshotDigest), 'INVALID_INPUT', 'Duplicate capability snapshot'); seenSnapshots.add(snapshot.snapshotDigest); validSnapshotDigests.push(snapshot.snapshotDigest);
    const host = catalog.hosts.find(h => h.id === snapshot.host);
    for (const b of snapshot.supportedBindings) {
      const key = digest({ snapshotDigest: snapshot.snapshotDigest, binding: b });
      const reason = [], m = exactModel(catalog, b.resolvedModel);
      if (!m) reason.push('UNRESOLVED_MODEL');
      if (!policy.allowedOrigins.includes(b.modelOrigin) || !ORIGINS.includes(b.modelOrigin)) reason.push('ORIGIN_EXCLUDED');
      if (m && m.modelOrigin !== b.modelOrigin) reason.push('ORIGIN_MISMATCH');
      if (b.model !== b.resolvedModel && (!b.aliasResolution || !m?.aliases.includes(b.model))) reason.push('ALIAS_UNVERIFIED');
      for (const f of b.possibleFallbacks) {
        const fm = exactModel(catalog, f.resolvedModel);
        if (!fm || fm.modelOrigin !== f.modelOrigin || !policy.allowedOrigins.includes(f.modelOrigin)) reason.push('FALLBACK_ORIGIN_UNVERIFIED');
      }
      // An advertised transparent fallback does not prove mandatory model/reasoning floors.
      if (b.possibleFallbacks.length && (request.highRisk || request.user?.strength === 'required' || request.requirements.requireObservable.length)) reason.push('FALLBACK_NOT_PINNED');
      if (!host || !policy.enabledHosts.includes(snapshot.host)) reason.push('HOST_DISABLED');
      if (!host?.autoDispatch) reason.push('RUNTIME_NOT_ENABLED');
      if (Date.parse(snapshot.observedAt) > nowMs || Date.parse(snapshot.expiresAt) <= nowMs) reason.push('CAPABILITY_EXPIRED');
      if (Date.parse(catalog.snapshotDate) > nowMs || nowMs - Date.parse(catalog.snapshotDate) > policy.maxCatalogAgeDays * 86_400_000) reason.push('CATALOG_STALE');
      if (m?.status === 'retired' || (m?.status === 'preview' && !policy.allowPreview) || (m?.status === 'seed' && !policy.allowSeedModels)) reason.push('MODEL_STATUS_BLOCKED');
      if (m && (!m.roles.includes(request.role) || (request.taskTraits ?? []).some(t => !m.taskTraits.includes(t)))) reason.push('TASK_NOT_SUITABLE');
      if (m && !m.nativeKinds.includes(b.nativeReasoning.kind)) reason.push('CONTROL_NOT_SUPPORTED');
      if (belowModelMinimum(b, m, policy)) reason.push('MODEL_MINIMUM_NOT_MET');
      if (!policy.allowedAccessPaths.includes(b.accessPath)) reason.push('ACCESS_PATH_NOT_APPROVED');
      const ex = snapshot.executionCapabilities, req = request.requirements;
      if (ex.dispatch !== true || ex.approvals !== 'enforced' || ex.isolation === 'unknown') reason.push('EXECUTION_BOUNDARY_UNKNOWN');
      if (!req.allowedSurfaces.includes(b.invocationSurface)) reason.push('SURFACE_NOT_ALLOWED');
      if (req.inputModalities.some(x => !ex.inputModalities.includes(x) || !m?.inputModalities.includes(x))) reason.push('INPUT_NOT_SUPPORTED');
      if (req.tools.some(t => !ex.tools.includes(t))) reason.push('TOOLS_NOT_SUPPORTED');
      if (['none', 'read', 'write'].indexOf(ex.filesystem) < ['none', 'read', 'write'].indexOf(req.filesystem)) reason.push('FILESYSTEM_NOT_SUPPORTED');
      if (!req.allowedRuntimeModes.includes(b.runtimeMode)) reason.push('RUNTIME_MODE_NOT_ALLOWED');
      if (b.runtimeMode !== 'standard' && !req.allowNestedDelegation) reason.push('NESTED_DELEGATION_FORBIDDEN');
      if (req.requireObservable.some(f => !b.observableFields.includes(f))) reason.push('OBSERVABILITY_INSUFFICIENT');
      if (req.excludedActors.includes(snapshot.actorId) || req.excludedSessions.includes(`${snapshot.host}/${snapshot.sessionId}`)) reason.push('INDEPENDENCE_CONFLICT');
      if (request.highRisk && (!legacyFloor(b, snapshot.host, m, policy) || snapshot.source === 'configuration' || !['model', 'reasoning', 'runtimeMode'].every(f => b.observableFields.includes(f)))) reason.push('HIGH_RISK_FLOOR_UNPROVEN');
      if (req.contextMode === 'full-history' && policy.fullHistoryInheritanceHosts.includes(snapshot.host)) reason.push('FULL_HISTORY_REQUIRES_LEGACY_INHERITANCE');
      const candidate = { key, model: m, snapshot, binding: b };
      if (request.user?.strength === 'required' && !matchesPreference(candidate, request.user, catalog)) reason.push('REQUIRED_CHOICE_UNAVAILABLE');
      if (reason.length) reject(key, reason); else candidates.push(candidate);
    }
  }
  const profile = request.profile ?? 'balanced';
  const seed = policy.profileOrder[profile][request.role];
  const traitSeed = [...new Set((request.taskTraits ?? []).slice().sort().flatMap(t => policy.traitOrder[t] ?? []))];
  function rank(candidate) {
    const preferred = matchesPreference(candidate, request.user, catalog) ? 0 : 1;
    const position = a => a.includes(candidate.model.id) ? a.indexOf(candidate.model.id) : a.length;
    const controls = policy.controlOrder.find(r => r.host === candidate.snapshot.host && r.role === request.role && r.profile === profile)?.controls ?? [];
    const controlRank = controls.findIndex(c => canonical(c) === canonical(candidate.binding.nativeReasoning));
    return [preferred, position(traitSeed), position(seed), controlRank < 0 ? controls.length : controlRank, candidate.key];
  }
  candidates.sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return lexical(x[4], y[4]); });
  const candidate = candidates[0];
  const fallback = candidate && request.user?.strength === 'preferred' && !matchesPreference(candidate, request.user, catalog) ? 'PREFERRED_CHOICE_UNAVAILABLE' : null;
  return seal({
    schemaVersion: '2.0.0', binding: structuredClone(request.binding), requestDigest: digest(request),
    catalogDigest: catalog.catalogDigest, policyDigest: digest(policy), capabilitySetDigest: digest(validSnapshotDigests.sort()),
    capabilitySnapshotDigest: candidate?.snapshot.snapshotDigest ?? null,
    requested: structuredClone(request.user ?? null), selected: candidate ? selectionFrom(candidate.binding) : null,
    target: candidate ? Object.fromEntries(TARGET_KEYS.map(k => [k, candidate.snapshot[k]])) : null,
    invocationSurface: candidate?.binding.invocationSurface ?? null,
    status: candidate ? 'selected' : 'blocked', executionAuthorized: false, trustedGateSatisfied: false,
    selectionReasonCodes: candidate ? [fallback ?? 'REVIEWED_SEED_AND_CAPABILITY_MATCH'] : [request.user?.strength === 'required' ? 'REQUIRED_CHOICE_UNAVAILABLE' : 'NO_ELIGIBLE_CANDIDATE'],
    rejectedCandidates: rejectedCandidates.sort((a, b) => lexical(a.candidateKey, b.candidateKey)), fallbackReason: fallback,
  }, 'decisionDigest');
}

/** Call immediately before dispatch, after the existing workflow has independently authorized it. */
export function revalidateDispatch(request, decision, environment) {
  verifySeal(decision, 'decisionDigest');
  assert(decision.status === 'selected', 'ASSIGNMENT_BLOCKED');
  const fresh = resolveV2(request, environment);
  assert(fresh.decisionDigest === decision.decisionDigest, 'DISPATCH_REVALIDATION_FAILED', 'Input, policy, catalog, capability, instance or expiry changed; resolve again');
  const p = environment.presence;
  assert(p && p.host === decision.target.host && p.sessionId === decision.target.sessionId && p.instanceId === decision.target.instanceId && p.state === 'online', 'PRESENCE_NOT_CURRENT');
  assert(instant(p.leaseUntil, 'presence leaseUntil') > instant(environment.now, 'now'), 'PRESENCE_EXPIRED');
  // This function deliberately does not consume a lease or issue execution permission.
  return { decisionDigest: decision.decisionDigest, preflight: 'current', executionAuthorized: false };
}

function fieldVerification(expected, actual, admitted) {
  if (actual === null || actual === undefined || !admitted) return 'unverified';
  return canonical(expected) === canonical(actual) ? 'matched' : 'mismatch';
}
/** Observations are diagnostic unless admitted by the host boundary outside the MCP request. */
export function recordV2(input, { request, decision, catalog, policy, capabilities, now, admittedObservation = null }) {
  keys(input, ['schemaVersion', 'binding', 'decisionDigest', 'target', 'dispatched', 'dispatchedAt', 'observation'], ['schemaVersion', 'binding', 'decisionDigest', 'target', 'dispatched', 'dispatchedAt']);
  assert(input.schemaVersion === '2.0.0', 'INVALID_INPUT'); instant(input.dispatchedAt, 'dispatchedAt'); assert(input.dispatchedAt === now, 'DISPATCH_TIME_MISMATCH'); validateBinding(input.binding); validateTarget(input.target); validateSelection(input.dispatched);
  verifySeal(decision, 'decisionDigest'); assert(decision.status === 'selected', 'ASSIGNMENT_BLOCKED');
  assert(canonical(input.binding) === canonical(decision.binding) && canonical(input.target) === canonical(decision.target) && input.decisionDigest === decision.decisionDigest, 'BINDING_MISMATCH');
  assert(digest(request) === decision.requestDigest, 'BINDING_MISMATCH');
  assert(canonical(input.dispatched) === canonical(decision.selected), 'DISPATCH_MISMATCH', 'Actual invocation must match selected configuration');
  // Re-resolve at the recorded dispatch time. Completion can arrive after snapshot expiration;
  // admission receipts bind the dispatch instant, not an arbitrarily refreshed capability.
  assert(resolveV2(request, { catalog, policy, capabilities, now }).decisionDigest === decision.decisionDigest, 'RECORD_REVALIDATION_FAILED');
  const observation = admittedObservation ?? input.observation ?? null;
  if (observation !== null) {
    keys(observation, ['binding', 'target', 'decisionDigest', 'source', 'reference', 'observedAt', 'models', 'nativeReasoning', 'runtimeMode', 'terminalOutcome']);
    validateBinding(observation.binding); validateTarget(observation.target);
    assert(canonical(observation.binding) === canonical(input.binding) && canonical(observation.target) === canonical(input.target) && observation.decisionDigest === input.decisionDigest, 'OBSERVATION_BINDING_MISMATCH');
    assert(['host-event', 'tool-result', 'agent-self-report'].includes(observation.source), 'INVALID_INPUT'); text(observation.reference, 'observation reference');
    instant(observation.observedAt, 'observedAt'); assert(Date.parse(observation.observedAt) >= Date.parse(now), 'OBSERVATION_PREDATES_DISPATCH');
    assert(Array.isArray(observation.models) && observation.models.length <= 32, 'INVALID_INPUT');
    for (const model of observation.models) { keys(model, ['resolvedModel', 'modelOrigin']); identifier(model.resolvedModel, 'observed model'); identifier(model.modelOrigin, 'observed origin'); }
    if (observation.nativeReasoning !== null) validateReasoning(observation.nativeReasoning);
    if (observation.runtimeMode !== null) identifier(observation.runtimeMode, 'runtimeMode');
    assert(['succeeded', 'failed', 'cancelled', 'unknown'].includes(observation.terminalOutcome), 'INVALID_INPUT');
  }
  const admitted = admittedObservation !== null && observation.source !== 'agent-self-report';
  const observedModels = observation?.models ?? [];
  const expectedModels = [{ resolvedModel: decision.selected.resolvedModel, modelOrigin: decision.selected.modelOrigin }];
  const modelVerification = fieldVerification(expectedModels, observedModels.length ? observedModels : null, admitted);
  const reasoningVerification = fieldVerification(decision.selected.nativeReasoning, observation?.nativeReasoning, admitted);
  const runtimeModeVerification = fieldVerification(decision.selected.runtimeMode, observation?.runtimeMode, admitted);
  const mismatch = [modelVerification, reasoningVerification, runtimeModeVerification].includes('mismatch');
  const originValid = observedModels.length > 0 && observedModels.every(m => policy.allowedOrigins.includes(m.modelOrigin) && exactModel(catalog, m.resolvedModel)?.modelOrigin === m.modelOrigin);
  return seal({
    schemaVersion: '2.0.0', binding: structuredClone(input.binding), target: structuredClone(input.target), decisionDigest: input.decisionDigest,
    requestDigest: decision.requestDigest, catalogDigest: decision.catalogDigest, policyDigest: decision.policyDigest,
    capabilitySnapshotDigest: decision.capabilitySnapshotDigest,
    requested: decision.requested, selected: decision.selected, dispatched: structuredClone(input.dispatched), dispatchedAt: input.dispatchedAt, observed: structuredClone(observation),
    modelVerification, reasoningVerification, runtimeModeVerification, originVerified: admitted && originValid,
    status: mismatch ? 'mismatch' : admitted && originValid && [modelVerification, reasoningVerification, runtimeModeVerification].every(v => v === 'matched') ? 'matched' : 'unverified',
    terminalOutcome: admitted ? observation.terminalOutcome : 'unknown', observationAdmitted: admitted,
    // Existing trusted execution-context/gate must still run; this is a separate evidence artifact.
    trustedGateSatisfied: false, artifactOnly: true,
  }, 'recordDigest');
}
