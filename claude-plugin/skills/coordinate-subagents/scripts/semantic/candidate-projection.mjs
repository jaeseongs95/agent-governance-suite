/** Pure projection of already-collected v2 candidates; not an eligibility or admission check. */
import {
  assert, canonical, digest, digestValue, identifier, keys, validateCapabilities,
} from '../model-routing-core.mjs';

export function projectSemanticCandidatesV1(candidates, metadata) {
  assert(Array.isArray(candidates) && candidates.length <= 65536, 'INVALID_INPUT', 'Invalid candidate list');
  assert(Array.isArray(metadata) && metadata.length === candidates.length, 'INVALID_INPUT', 'Incomplete baseline metadata');
  if (candidates.length === 0) return null; // Caller uses the existing v2 blocked decision.

  const byKey = new Map();
  for (const candidate of candidates) {
    keys(candidate, ['key', 'model', 'snapshot', 'binding']);
    digestValue(candidate.key, 'candidate key');
    validateCapabilities(candidate.snapshot);
    identifier(candidate.model?.id, 'candidate model');
    assert(candidate.model.id === candidate.binding?.resolvedModel, 'INVALID_INPUT', 'Candidate model differs from binding');
    assert(candidate.snapshot.supportedBindings.some(binding => canonical(binding) === canonical(candidate.binding)), 'INVALID_INPUT', 'Binding absent from snapshot');
    assert(candidate.key === digest({ snapshotDigest: candidate.snapshot.snapshotDigest, binding: candidate.binding }), 'DIGEST_MISMATCH', 'Candidate key differs from binding');
    assert(!byKey.has(candidate.key), 'INVALID_INPUT', 'Duplicate candidate key');
    byKey.set(candidate.key, candidate);
  }

  const seen = new Set();
  for (const item of metadata) keys(item, ['candidateKey', 'preferenceGroup', 'baselineRank']);
  const eligibleSet = [...metadata].sort((a, b) => a.baselineRank - b.baselineRank).map((item, baselineRank) => {
    const candidate = byKey.get(item.candidateKey);
    assert(candidate && !seen.has(item.candidateKey), 'INVALID_INPUT', 'Missing or duplicate baseline candidate');
    assert(item.baselineRank === baselineRank && Number.isSafeInteger(item.preferenceGroup) && item.preferenceGroup >= 0, 'INVALID_INPUT', 'Invalid baseline order');
    seen.add(item.candidateKey);
    return { candidateKey: item.candidateKey, model: candidate.model.id, preferenceGroup: item.preferenceGroup, baselineRank };
  });
  assert(eligibleSet.every((item, index) => index === 0 || item.preferenceGroup >= eligibleSet[index - 1].preferenceGroup), 'INVALID_INPUT', 'Preference groups out of order');

  const byModel = new Map();
  for (const item of eligibleSet) {
    if (!byModel.has(item.model)) byModel.set(item.model, []);
    byModel.get(item.model).push(item.candidateKey);
  }
  assert(byModel.size <= 256, 'INVALID_INPUT', 'Too many model options');
  const options = [...byModel].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([model, candidateKeys]) => ({ optionId: model, model, candidateKeys: candidateKeys.sort() }));
  return { eligibleSet, options };
}
