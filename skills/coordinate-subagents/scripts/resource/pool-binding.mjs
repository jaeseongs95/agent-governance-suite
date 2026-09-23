/** Pure projection of server-owned configuration. It does not observe quota or grant resource authority. */
import {
  assert, canonical, digest, digestValue, identifier, keys, validateCapabilities,
} from '../model-routing-core.mjs';

const ACCOUNT = /^acct-hmac-sha256:[a-f0-9]{64}$/u;
const ACCESS = ['subscription', 'api', 'enterprise'];
function account(value) {
  assert(typeof value === 'string' && ACCOUNT.test(value), 'INVALID_INPUT', 'Account scope must be a keyed pseudonym');
}

/**
 * Resolve each concrete v2 candidate to an explicitly approved shared pool set.
 * A missing configuration or approved pool remains unknown; configuration never becomes observation.
 */
export function bindCandidatesToResourcePoolsV1(candidates, { mappings, approvedPools }) {
  assert(Array.isArray(candidates) && candidates.length <= 65536, 'INVALID_INPUT', 'Invalid candidates');
  assert(Array.isArray(mappings) && mappings.length <= 65536, 'INVALID_INPUT', 'Invalid pool mappings');
  assert(Array.isArray(approvedPools) && approvedPools.length <= 65536, 'INVALID_INPUT', 'Invalid approved pools');

  const pools = new Map();
  for (const pool of approvedPools) {
    keys(pool, ['resourcePoolId', 'accountScope', 'accessPath']);
    identifier(pool.resourcePoolId, 'resourcePoolId'); account(pool.accountScope);
    assert(ACCESS.includes(pool.accessPath), 'INVALID_INPUT', 'Invalid pool access path');
    assert(!pools.has(pool.resourcePoolId), 'INVALID_INPUT', 'Duplicate or conflicting approved pool');
    pools.set(pool.resourcePoolId, pool);
  }

  const byCandidate = new Map();
  for (const mapping of mappings) {
    keys(mapping, ['candidateKey', 'resolvedModel', 'host', 'accessPath', 'accountScope', 'resourcePoolIds']);
    digestValue(mapping.candidateKey, 'candidateKey');
    identifier(mapping.resolvedModel, 'resolvedModel'); identifier(mapping.host, 'host'); account(mapping.accountScope);
    assert(ACCESS.includes(mapping.accessPath), 'INVALID_INPUT', 'Invalid mapping access path');
    assert(Array.isArray(mapping.resourcePoolIds) && mapping.resourcePoolIds.length <= 64
      && new Set(mapping.resourcePoolIds).size === mapping.resourcePoolIds.length, 'INVALID_INPUT', 'Invalid pool set');
    for (const poolId of mapping.resourcePoolIds) identifier(poolId, 'resourcePoolId');
    assert(!byCandidate.has(mapping.candidateKey), 'INVALID_INPUT', 'Duplicate candidate mapping');
    byCandidate.set(mapping.candidateKey, mapping);
  }

  const seen = new Set();
  return candidates.map((candidate) => {
    keys(candidate, ['key', 'model', 'snapshot', 'binding']);
    digestValue(candidate.key, 'candidate key');
    validateCapabilities(candidate.snapshot);
    identifier(candidate.model?.id, 'candidate model');
    assert(candidate.model.id === candidate.binding?.resolvedModel
      && candidate.snapshot.supportedBindings.some((binding) => canonical(binding) === canonical(candidate.binding))
      && candidate.key === digest({ snapshotDigest: candidate.snapshot.snapshotDigest, binding: candidate.binding }),
    'INVALID_INPUT', 'Candidate does not match its concrete binding');
    assert(!seen.has(candidate.key), 'INVALID_INPUT', 'Duplicate candidate'); seen.add(candidate.key);

    const mapping = byCandidate.get(candidate.key);
    if (!mapping || mapping.resourcePoolIds.length === 0) {
      return { candidateKey: candidate.key, status: 'unknown', poolRefs: [], mappingSource: 'unknown' };
    }
    assert(mapping.resolvedModel === candidate.binding.resolvedModel
      && mapping.host === candidate.snapshot.host
      && mapping.accessPath === candidate.binding.accessPath,
    'INVALID_INPUT', 'Mapping conflicts with concrete candidate');
    let missingPool = false;
    for (const poolId of mapping.resourcePoolIds) {
      const pool = pools.get(poolId);
      if (!pool) { missingPool = true; continue; }
      assert(pool.accountScope === mapping.accountScope && pool.accessPath === mapping.accessPath,
        'INVALID_INPUT', 'Pool account or access path conflicts with mapping');
    }
    if (missingPool) return { candidateKey: candidate.key, status: 'unknown', poolRefs: [], mappingSource: 'unknown' };
    return {
      candidateKey: candidate.key,
      status: 'mapped',
      poolRefs: [...mapping.resourcePoolIds].sort().map((resourcePoolId) => ({
        resourcePoolId, accountScope: mapping.accountScope, accessPath: mapping.accessPath,
      })),
      mappingSource: 'configuration',
    };
  });
}
