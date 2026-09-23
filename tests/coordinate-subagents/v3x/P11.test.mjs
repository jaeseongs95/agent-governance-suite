import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { ArtifactRetentionStore } from '../../../mcp-server/src/artifacts/retention.ts';
import { ReplayMaterialLoader } from '../../../mcp-server/src/artifacts/replay-loader.ts';
import { SnapshotSetStore } from '../../../mcp-server/src/artifacts/snapshot-set.ts';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';
import { SemanticAdviceAdmissionStore } from '../../../mcp-server/src/semantic/advice-admission.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import { SemanticReplaySnapshotPublisher } from '../../../mcp-server/src/semantic/replay-snapshot.ts';
import { canonical, collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { SEMANTIC_REDUCER_VERSION_V1 } from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';
import { LATER } from '../model-routing-v2/fixtures.mjs';

const roles = ['request', 'policy', 'catalog', 'capability', 'advice'];

async function fixture(run, omitted = null) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ags-p11-'));
  const root = path.join(dir, 'artifacts');
  const workflow = new SqliteWorkflowStore(path.join(dir, 'workflow.sqlite3'));
  const database = new DatabaseSync(path.join(dir, 'workflow.sqlite3'));
  const retention = new ArtifactRetentionStore(path.join(dir, 'retention.sqlite3'));
  try {
    const base = contracts('assist');
    const pool = collectEligibleCandidatesV2(base.legacy.req, base.legacy.env);
    const metadata = getBaselineCandidateMetadataV2(pool.candidates, base.legacy.req, base.legacy.env);
    const mapping = projectSemanticCandidatesV1(pool.candidates, metadata);
    const request = resealRequest({ ...base.request, reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
      capabilitySetDigest: pool.capabilitySetDigest,
      eligibleSet: mapping.eligibleSet, options: mapping.options });
    const choice = { status: 'success', choice: {
      kind: 'Choice', selectedOptionIds: [request.options[0].optionId], confidence: 0.75 } };
    const intents = new SemanticEvaluationIntentStore(database);
    intents.begin('p11-intent', request);
    const claim = intents.claim(request.evaluationId, request.requestDigest, 'runner-a');
    intents.recordResult(request.evaluationId, request.requestDigest, claim.claimId, choice);
    const admission = new SemanticAdviceAdmissionStore(database, () => LATER);
    const registered = admission.register(request.evaluationId);
    const archive = { routingRequest: base.legacy.req, prepared: request,
      adoption: { status: 'eligible', evidenceDigest: digest('fixture-adoption') },
      decisionTime: LATER, reducerVersion: request.reducerVersion };
    const material = { request: archive, policy: base.legacy.env.policy,
      catalog: base.legacy.env.catalog, capability: base.legacy.env.capabilities,
      advice: registered.advice };
    const store = new RawContentStore(root);
    const refs = {};
    for (const role of roles) {
      const bytes = Buffer.from(canonical(material[role]), 'utf8');
      refs[role] = { schemaVersion: '1.0.0', namespace: 'task', id: `replay-${role}`,
        digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/json' };
      if (role !== omitted) await store.put(refs[role], bytes);
    }
    const principal = { workspaceId: 'workspace-1', taskId: request.binding.taskId };
    const grants = roles.map(role => ({ ref: refs[role], ...principal }));
    let consumed = { evaluationId: request.evaluationId, registrationId: registered.registrationId,
      adviceDigest: registered.advice.adviceDigest, adoption: archive.adoption, decisionTime: LATER };
    const consumption = { read: () => consumed };
    const publisher = new SemanticReplaySnapshotPublisher(root, principal, grants, retention, admission, intents, consumption);
    await run({ root, request, registered, refs, principal, grants, publisher, retention, material,
      admission, intents, consumption, getConsumption: () => consumed,
      setConsumption: value => { consumed = value; } });
  } finally {
    retention.close(); database.close(); workflow.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('P11 publishes a pinned A04 manifest with the exact consumed P10 advice and projection identity', async () => {
  await fixture(async ({ root, request, registered, refs, principal, grants, publisher, retention }) => {
    const input = { evaluationId: request.evaluationId, materials: refs };
    const first = await publisher.publish(input);
    assert.equal(first.registrationId, registered.registrationId);
    assert.equal(first.adviceDigest, registered.advice.adviceDigest);
    assert.equal(first.reducerVersion, request.reducerVersion);
    assert.equal(first.projection.optionMappingDigest, request.optionMappingDigest);
    assert.deepEqual(await publisher.publish(input), first);
    const reader = new SnapshotSetStore(root, principal, [...grants, { ref: first.manifestRef, ...principal }]);
    assert.deepEqual((await reader.load(first.manifestRef)).inputs, refs);
    const replay = await new ReplayMaterialLoader(root, principal,
      [...grants, { ref: first.manifestRef, ...principal }]).load(first.manifestRef);
    assert.equal(replay.status, 'ready');
    assert.equal(replay.input.advice.adviceDigest, registered.advice.adviceDigest);
    for (const ref of [...Object.values(refs), first.manifestRef]) {
      assert.equal(retention.replayState(ref), 'not-tombstoned');
      assert.equal(retention.tombstone(ref), 'pinned');
    }
  });
});

test('P11 fixes all material references before the first asynchronous read', async () => {
  await fixture(async ({ root, request, registered, refs, principal, grants,
    retention, admission, intents, consumption }) => {
    const other = seal({ ...registered.advice, choice: {
      ...registered.advice.choice, confidence: 0.5 } }, 'adviceDigest');
    const bytes = Buffer.from(canonical(other), 'utf8');
    const alternative = { ...refs.advice, id: 'other-advice', size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    await new RawContentStore(root).put(alternative, bytes);
    const publisher = new SemanticReplaySnapshotPublisher(root, principal,
      [...grants, { ref: alternative, ...principal }], retention, admission, intents, consumption);
    const materials = { ...refs };
    const originalRead = publisher.access.read.bind(publisher.access);
    let changed = false;
    publisher.access.read = async ref => {
      const content = await originalRead(ref);
      if (!changed) { changed = true; materials.advice = alternative; }
      return content;
    };
    const published = await publisher.publish({ evaluationId: request.evaluationId, materials });
    const manifest = await new SnapshotSetStore(root, principal,
      [...grants, { ref: published.manifestRef, ...principal }]).load(published.manifestRef);
    assert.deepEqual(manifest.inputs.advice, refs.advice);
    assert.equal(published.adviceDigest, registered.advice.adviceDigest);
  });
});

test('P11 rejects non-JSON member media type and extra adoption fields before publish', async () => {
  await fixture(async ({ root, request, refs, principal, grants, retention,
    admission, intents, consumption, material }) => {
    const nonJson = { ...refs.capability, mediaType: 'application/octet-stream' };
    const altered = { ...refs, capability: nonJson };
    const alteredGrants = grants.map(grant => grant.ref.id === refs.capability.id
      ? { ...grant, ref: nonJson } : grant);
    const publisher = new SemanticReplaySnapshotPublisher(root, principal, alteredGrants,
      retention, admission, intents, consumption);
    await assert.rejects(() => publisher.publish({ evaluationId: request.evaluationId,
      materials: altered }), { code: 'GATE_FAILED' });

    const archive = { ...material.request,
      adoption: { ...material.request.adoption, callerApproved: true } };
    const bytes = Buffer.from(canonical(archive), 'utf8');
    const changedRequest = { ...refs.request, id: 'extra-adoption', size: bytes.length,
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` };
    await new RawContentStore(root).put(changedRequest, bytes);
    const otherPublisher = new SemanticReplaySnapshotPublisher(root, principal,
      [...grants, { ref: changedRequest, ...principal }], retention, admission, intents, consumption);
    await assert.rejects(() => otherPublisher.publish({ evaluationId: request.evaluationId,
      materials: { ...refs, request: changedRequest } }), { code: 'GATE_FAILED' });
    assert.equal(retention.replayState(refs.request), 'unknown');
  });
});

test('P11 does not publish when a member is missing or consumed advice differs', async () => {
  await fixture(async ({ request, refs, publisher, retention }) => {
    await assert.rejects(() => publisher.publish({ evaluationId: request.evaluationId, materials: refs }));
    assert.equal(retention.replayState(refs.request), 'unknown');
  }, 'capability');
  await fixture(async ({ request, refs, publisher, retention, setConsumption }) => {
    setConsumption(null);
    await assert.rejects(() => publisher.publish({ evaluationId: request.evaluationId,
      materials: refs }), { code: 'GATE_FAILED' });
    assert.equal(retention.replayState(refs.request), 'unknown');
  });
});

test('P11 leaves pins pending if manifest publication fails before reference return', async () => {
  await fixture(async ({ request, refs, publisher, retention }) => {
    publisher.snapshots.publish = async () => { throw new Error('injected manifest write failure'); };
    await assert.rejects(() => publisher.publish({ evaluationId: request.evaluationId, materials: refs }), /injected/);
    for (const ref of Object.values(refs)) assert.equal(retention.tombstone(ref), 'pinned');
  });
});

test('P11 rejects cross-task scope and unrecorded or forged adoption', async () => {
  await fixture(async ({ root, request, refs, publisher, retention, admission, intents,
    consumption, getConsumption, setConsumption }) => {
    const wrongPrincipal = { workspaceId: 'workspace-1', taskId: 'different-task' };
    const wrongGrants = roles.map(role => ({ ref: refs[role], ...wrongPrincipal }));
    const foreign = new SemanticReplaySnapshotPublisher(root, wrongPrincipal, wrongGrants,
      retention, admission, intents, consumption);
    await assert.rejects(() => foreign.publish({ evaluationId: request.evaluationId, materials: refs }),
      { code: 'GATE_FAILED' });
    setConsumption({ ...getConsumption(), adoption: {
      status: 'eligible', evidenceDigest: digest('forged-adoption') } });
    await assert.rejects(() => publisher.publish({ evaluationId: request.evaluationId, materials: refs }),
      { code: 'GATE_FAILED' });
    assert.equal(retention.replayState(refs.request), 'unknown');
  });
});
