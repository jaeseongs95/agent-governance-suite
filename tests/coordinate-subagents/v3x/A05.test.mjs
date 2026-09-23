import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, vi } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { ReplayMaterialLoader } from '../../../mcp-server/src/artifacts/replay-loader.ts';
import { SnapshotSetStore } from '../../../mcp-server/src/artifacts/snapshot-set.ts';
import {
  collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { replaySemanticDecisionV1, SEMANTIC_REDUCER_VERSION_V1 } from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { capability, environment, LATER, request } from '../model-routing-v2/fixtures.mjs';
import { bindingFields, contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const principal = { workspaceId: 'workspace-1', taskId: 'task-1' };
const grant = ref => ({ ref, ...principal });
const objectPath = (root, ref) => path.join(root, 'objects', ref.namespace, ref.digest.slice(7, 9), ref.digest.slice(7));

function archived() {
  const routingRequest = request();
  const env = environment({ capabilities: [
    capability({ actorId: 'actor-a', sessionId: 'session-a' }),
    capability({ actorId: 'actor-b', sessionId: 'session-b' },
      { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ], now: LATER });
  const pool = collectEligibleCandidatesV2(routingRequest, env);
  const mapping = projectSemanticCandidatesV1(pool.candidates,
    getBaselineCandidateMetadataV2(pool.candidates, routingRequest, env));
  const prepared = resealRequest({
    ...contracts().request, reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
    binding: structuredClone(routingRequest.binding), effectiveRoutingRequestDigest: digest(routingRequest),
    catalogDigest: env.catalog.catalogDigest, routingPolicyDigest: digest(env.policy),
    capabilitySetDigest: pool.capabilitySetDigest, eligibleSet: mapping.eligibleSet, options: mapping.options,
  });
  const advice = seal({
    ...contracts().advice,
    ...Object.fromEntries(bindingFields.map(key => [key, structuredClone(prepared[key])])),
    semanticRequestDigest: prepared.requestDigest,
    choice: { kind: 'Choice', selectedOptionIds: mapping.options.map(option => option.optionId), confidence: 0.75 },
  }, 'adviceDigest');
  const adoption = { status: 'eligible', evidenceDigest: digest('archived-admission') };
  return {
    values: { request: { routingRequest, prepared, adoption, decisionTime: LATER,
      reducerVersion: SEMANTIC_REDUCER_VERSION_V1 }, policy: env.policy, catalog: env.catalog,
    capability: env.capabilities, advice },
    replay: { routingRequest, environment: env, prepared, advice, adoption,
      decisionTime: LATER, reducerVersion: SEMANTIC_REDUCER_VERSION_V1 },
  };
}

async function fixture(root, values = archived().values) {
  const store = new RawContentStore(root);
  const refs = {};
  for (const [role, value] of Object.entries(values)) {
    const bytes = Buffer.from(JSON.stringify(value));
    const ref = { schemaVersion: '1.0.0', namespace: 'task', id: role,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/json' };
    await store.put(ref, bytes);
    refs[role] = ref;
  }
  const manifestRef = await new SnapshotSetStore(root, principal, Object.values(refs).map(grant)).publish(refs);
  return { refs, manifestRef, loader: grants => new ReplayMaterialLoader(root, principal, grants) };
}

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a05-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('A05 loads the archived S07 input and replays offline with zero provider calls', async () => isolated(async root => {
  const expected = archived();
  const { refs, manifestRef, loader } = await fixture(root, expected.values);
  const fetch = vi.fn(() => { throw new Error('provider called'); });
  const NativeDate = globalThis.Date;
  class NoCurrentDate extends NativeDate {
    constructor(...args) { if (args.length === 0) throw new Error('current clock accessed'); super(...args); }
    static now() { throw new Error('current clock accessed'); }
  }
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('Date', NoCurrentDate);
  try {
    const result = await loader([manifestRef, ...Object.values(refs)].map(grant)).load(manifestRef);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.input, expected.replay);
    assert.equal(replaySemanticDecisionV1(result.input).decisionDigest,
      replaySemanticDecisionV1(expected.replay).decisionDigest);
    assert.equal(fetch.mock.calls.length, 0);
  } finally { vi.unstubAllGlobals(); }
}));

test('A05 separates missing bytes, denied grant, corrupt bytes, and unsupported version', async () => isolated(async root => {
  const { refs, manifestRef, loader } = await fixture(root);
  const allGrants = [manifestRef, ...Object.values(refs)].map(grant);
  assert.deepEqual(await loader(allGrants.filter(g => g.ref.id !== 'advice')).load(manifestRef), { status: 'denied' });
  await rm(objectPath(root, refs.advice));
  assert.deepEqual(await loader(allGrants).load(manifestRef), { status: 'missing' });
  await writeFile(objectPath(root, refs.advice), Buffer.from('tampered'));
  assert.deepEqual(await loader(allGrants).load(manifestRef), { status: 'corrupt' });
}));

test('A05 refuses absent and unknown reducer versions without a current fallback', async () => isolated(async root => {
  for (const reducerVersion of [undefined, 'future-reducer-v2']) {
    const rootForCase = await mkdtemp(path.join(root, 'case-'));
    const values = archived().values;
    if (reducerVersion === undefined) delete values.request.reducerVersion;
    else values.request.reducerVersion = reducerVersion;
    const { refs, manifestRef, loader } = await fixture(rootForCase, values);
    assert.deepEqual(await loader([manifestRef, ...Object.values(refs)].map(grant)).load(manifestRef),
      { status: 'unsupported-version' });
  }
}));

test('A05 classifies a saved invalid decision time as corrupt', async () => isolated(async root => {
  const values = archived().values;
  values.request.decisionTime = 'not-a-time';
  const { refs, manifestRef, loader } = await fixture(root, values);
  assert.deepEqual(await loader([manifestRef, ...Object.values(refs)].map(grant)).load(manifestRef),
    { status: 'corrupt' });
}));
