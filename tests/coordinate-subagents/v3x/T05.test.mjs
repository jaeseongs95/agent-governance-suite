import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { RegisteredDecisionWriter } from '../../../mcp-server/src/routing-v3/decision-writer.ts';
import { revalidateStoredSemanticDispatch } from '../../../mcp-server/src/routing-v3/revalidate-dispatch.ts';
import { SemanticAdviceAdmissionStore } from '../../../mcp-server/src/semantic/advice-admission.ts';
import { SemanticEvaluationIntentStore } from '../../../mcp-server/src/semantic/evaluation-intent.ts';
import {
  collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, resolveV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { SEMANTIC_REDUCER_VERSION_V1 } from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { capability, environment, NOW, LATER, END, request } from '../model-routing-v2/fixtures.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const CAPABILITY_END = '2026-09-21T13:00:00.000Z';

function fixture() {
  const db = new DatabaseSync(':memory:');
  onTestFinished(() => db.close());
  const store = new ModelRoutingStore(db), base = contracts();
  const routingRequest = request();
  const routingEnvironment = environment({ now: NOW, capabilities: [
    capability({ actorId: 'actor-terra', sessionId: 'session-terra', expiresAt: CAPABILITY_END }),
    capability({ actorId: 'actor-sol', sessionId: 'session-sol', expiresAt: CAPABILITY_END },
      { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ] });
  const policy = { ...base.policy, mode: 'assist',
    adoption: { status: 'validated', minimumConfidence: 0.5,
      evidenceDigest: digest('t05-admitted-evidence'), provider: base.request.provider,
      questionDigest: digest(base.question), reducerVersion: SEMANTIC_REDUCER_VERSION_V1 },
    egress: { enabled: true, allowedProviders: [base.request.provider.id] } };
  const baseline = resolveV2(routingRequest, routingEnvironment);
  store.saveDecision(routingRequest, routingEnvironment, baseline, NOW);
  const pool = collectEligibleCandidatesV2(routingRequest, routingEnvironment);
  const metadata = getBaselineCandidateMetadataV2(pool.candidates, routingRequest, routingEnvironment);
  const projection = projectSemanticCandidatesV1(pool.candidates, metadata);
  const prepared = resealRequest({ ...base.request, evaluationId: 't05-evaluation',
    binding: structuredClone(routingRequest.binding),
    effectiveRoutingRequestDigest: digest(routingRequest),
    catalogDigest: routingEnvironment.catalog.catalogDigest,
    routingPolicyDigest: digest(routingEnvironment.policy),
    semanticPolicyDigest: digest(policy), capabilitySetDigest: pool.capabilitySetDigest,
    eligibleSet: projection.eligibleSet, options: projection.options,
    reducerVersion: SEMANTIC_REDUCER_VERSION_V1 });
  const intents = new SemanticEvaluationIntentStore(db);
  intents.begin('t05-key', prepared);
  const claim = intents.claim(prepared.evaluationId, prepared.requestDigest, 'runner-t05');
  intents.recordResult(prepared.evaluationId, prepared.requestDigest, claim.claimId,
    { status: 'success', choice: { kind: 'Choice',
      selectedOptionIds: [prepared.options[0].optionId], confidence: 0.8 } });
  const admission = new SemanticAdviceAdmissionStore(db, () => LATER);
  const registered = admission.register(prepared.evaluationId);
  const decision = new RegisteredDecisionWriter(store, { read: () => ({ status: 'eligible',
    evidenceDigest: policy.adoption.evidenceDigest }) }).write({ evaluationId: prepared.evaluationId,
      registrationId: registered.registrationId, baselineDecisionDigest: baseline.decisionDigest,
      decisionTime: LATER });
  const current = { environment: { ...routingEnvironment, now: LATER },
    semanticPolicy: structuredClone(policy),
    authorization: { allowed: true, binding: structuredClone(decision.binding), leaseState: 'consumed' },
    presence: { ...decision.target, state: 'online', leaseUntil: END } };
  return { db, store, intents, admission, decision, policy, current };
}

function preflight(f, current = f.current, policy = f.policy) {
  return revalidateStoredSemanticDispatch(f.store, f.intents, f.admission,
    f.decision.decisionDigest, policy, () => current);
}

test('stored v3 replays at decision time, then current preflight remains non-authorizing', () => {
  const f = fixture();
  assert.deepEqual(preflight(f), { decisionDigest: f.decision.decisionDigest,
    preflight: 'current', executionAuthorized: false });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM ags_model_decision_refs_v3').get().n, 1);
});

test('historical replay failure stops before consulting current authorization', () => {
  const f = fixture();
  let currentReads = 0;
  assert.throws(() => revalidateStoredSemanticDispatch(f.store, f.intents, f.admission,
    f.decision.decisionDigest,
    { ...f.policy, version: 'changed' }, () => { currentReads++; return f.current; }),
  { code: 'HISTORICAL_POLICY_MISMATCH' });
  assert.equal(currentReads, 0);
});

test('missing writer reference and advice expired at the recorded decision time fail historical replay', () => {
  const missing = fixture();
  missing.db.prepare('DELETE FROM ags_model_decision_refs_v3 WHERE decision_digest=?')
    .run(missing.decision.decisionDigest);
  assert.throws(() => preflight(missing), { code: 'SEMANTIC_REFERENCE_MISMATCH' });

  const expired = fixture();
  expired.db.prepare('UPDATE ags_model_decisions_v2 SET resolved_at=? WHERE decision_digest=?')
    .run(END, expired.decision.decisionDigest);
  assert.throws(() => preflight(expired), { code: 'REPLAY_TIME_MISMATCH' });
});

test('current authorization, lease, revision, policy, capability and presence drift fail closed', () => {
  const f = fixture();
  assert.throws(() => revalidateStoredSemanticDispatch(f.store, f.intents, f.admission,
    f.decision.decisionDigest, f.policy, () => null), { code: 'DISPATCH_CONTEXT_UNAVAILABLE' });
  const changes = [
    [current => { current.authorization.allowed = false; }, 'DISPATCH_AUTHORIZATION_STALE'],
    [current => { current.authorization.leaseState = 'available'; }, 'DISPATCH_LEASE_STALE'],
    [current => { current.authorization.binding.attemptId = 'different-attempt'; }, 'DISPATCH_LEASE_STALE'],
    [current => { current.authorization.binding.revision++; }, 'DISPATCH_REVISION_STALE'],
    [current => { current.environment.now = NOW; }, 'DISPATCH_TIME_REGRESSION'],
    [current => { current.environment.policy.maxCatalogAgeDays++; }, 'DISPATCH_POLICY_STALE'],
    [current => { current.environment.catalog.catalogDigest = digest('changed-catalog'); }, 'DISPATCH_POLICY_STALE'],
    [current => { current.semanticPolicy.version = 'changed'; }, 'DISPATCH_SEMANTIC_POLICY_STALE'],
    [current => { current.environment.capabilities = []; }, 'DISPATCH_CAPABILITY_STALE'],
    [current => { current.environment.capabilities[0] = seal({
      ...current.environment.capabilities[0], instanceId: 'different-capability-instance',
    }, 'snapshotDigest'); }, 'DISPATCH_CAPABILITY_STALE'],
    [current => { current.presence.instanceId = 'different-instance'; }, 'PRESENCE_NOT_CURRENT'],
    [current => { current.presence.state = 'offline'; }, 'PRESENCE_NOT_CURRENT'],
    [current => { current.presence.leaseUntil = NOW; }, 'PRESENCE_EXPIRED'],
  ];
  for (const [change, code] of changes) {
    const current = structuredClone(f.current);
    change(current);
    assert.throws(() => preflight(f, current), { code });
  }
});

test('historically valid advice may expire while current capability remains eligible; later capability expiry blocks', () => {
  const f = fixture();
  const current = structuredClone(f.current);
  current.environment.now = '2026-09-21T12:05:00.000Z';
  current.presence.leaseUntil = CAPABILITY_END;
  assert.equal(preflight(f, current).preflight, 'current');
  current.environment.now = '2026-09-21T13:01:00.000Z';
  current.presence.leaseUntil = '2026-09-21T13:02:00.000Z';
  assert.throws(() => preflight(f, current), { code: 'DISPATCH_SELECTION_STALE' });
});
