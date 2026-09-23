import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRoutingStore } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ModelRoutingServiceCore } from '../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs';
import { ModelPeerPacketSigner, peerMessageId } from '../../mcp-server/src/model-peer-packet.js';
import { encodePeerAssignment } from '../../skills/coordinate-subagents/scripts/model-routing-peer.mjs';
import { digest, resolveV2, seal } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { SENDER, RECEIVER, TOKEN, PEER_NOW as NOW } from './peer-handoff-fixtures.mjs';
import { fixture, accepted, retained, lastAwait } from './peer-execution-fixtures.mjs';

afterEach(() => vi.restoreAllMocks());

describe('accepted peer execution preflight (no worker start)', () => {
  it('rechecks an accepted inbound packet without changing any workflow, reservation, receipt or message', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h), count = h.calls.length;
    const result = await h.receiver.preflight(id);
    expect(result).toMatchObject({ packetId: id, decisionDigest: h.decision.decisionDigest, dispatchKey: h.key,
      dispatchRevision: 1, checkedAt: NOW, preflightPassed: true, requiresAtomicStart: true,
      executionStarted: false, executionAuthorized: false, trustedGateSatisfied: false, completed: false, executionState: 'not-observed' });
    expect(await h.receiver.preflight(id)).toEqual(result);
    expect(retained(h)).toEqual(before);
    expect(h.calls.slice(count).every(op => ['ping', 'list-model-capabilities', 'presence'].includes(op))).toBe(true);
  });
});

describe.each(['preflight', 'start'])('%s rejects unsafe accepted work without changing it', operation => {
  const check = (receiver, id) => operation === 'start' ? receiver.start(id, 1) : receiver.preflight(id);
  it('does not treat a delivered ACK or an outbound accepted receipt as receiver admission', async () => {
    const h = fixture(), sent = await h.sender.send(h.decision.decisionDigest);
    const message = h.claim(RECEIVER)[0];
    h.sessions.acknowledge(RECEIVER, [sent.packetId], h.now());
    await expect(check(h.receiver, sent.packetId)).rejects.toThrow(/accepted inbound/u);
    expect(h.routing.dispatch(h.key)).toBeNull();
    await h.receiver.receive(message);
    await h.sender.receive(h.claim(SENDER)[0]);
    await expect(check(h.sender, sent.packetId)).rejects.toThrow(/receiver/u);
  });
  it.each(['reserved', 'running', 'unknown', 'succeeded', 'failed', 'cancelled', 'not-started'])('never reopens or starts an existing %s dispatch', async state => {
    const h = fixture(), id = await accepted(h);
    h.database.prepare('UPDATE ags_model_dispatches_v2 SET state=? WHERE dispatch_key=?').run(state, h.key);
    const before = retained(h);
    await expect(check(h.receiver, id)).rejects.toThrow(/dispatch/iu);
    expect(retained(h)).toEqual(before);
  });
  it.each(['actor', 'instance', 'host'])('rejects a different local %s without mutating acceptance', async kind => {
    const h = fixture(), id = await accepted(h), before = retained(h);
    const receiver = h.peer({ ...RECEIVER, ...(kind === 'instance' ? { instanceId: 'replacement' } : {}),
      ...(kind === 'host' ? { host: 'claude-code' } : {}) }, { actor: kind === 'actor' ? 'other' : h.actorId, request: h.transport, clock: h.now });
    await expect(check(receiver, id)).rejects.toThrow(/actor|receiver/u); expect(retained(h)).toEqual(before);
  });
  it.each(['sender', 'recipient', 'capability'])('rejects expired or replaced %s observations', async kind => {
    const h = fixture(), id = await accepted(h), before = retained(h);
    if (kind === 'capability') {
      h.advance(1); h.publish(seal({ ...h.cap, observedAt: new Date(h.now()).toISOString() }, 'snapshotDigest'));
    } else {
      const identity = kind === 'sender' ? SENDER : RECEIVER;
      h.sessions.startPresence({ ...identity, instanceId: 'replacement', transport: 'fixture', wakeVisibility: 'none', canWakeSilently: false }, h.now());
    }
    await expect(check(h.receiver, id)).rejects.toThrow(); expect(retained(h)).toEqual(before);
  });
  it('does not refresh expired proposal signatures or release their accepted write exclusions', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h); h.advance(60000);
    await expect(check(h.receiver, id)).rejects.toThrow(/expired/u); expect(retained(h)).toEqual(before);
    const replacement = seal({ ...h.decision, binding: { ...h.req.binding, assignmentId: 'replacement', revision: h.req.binding.revision + 1 } }, 'decisionDigest');
    expect(() => h.routing.reserveDispatch(replacement, { write: true })).toThrow(/AMBIGUOUS_WRITE_ACTIVE/u);
  });
  it.each(['inputDigest', 'candidateDigest', 'taskId', 'runId', 'stageId', 'attemptId', 'assignmentId', 'revision'])('rejects a changed stored %s binding', async field => {
    const h = fixture(), id = await accepted(h), request = structuredClone(h.req);
    request.binding[field] = field.endsWith('Digest') ? digest('changed') : field === 'revision' ? request.binding.revision + 1 : 'other';
    h.database.prepare('UPDATE ags_model_decisions_v2 SET request_json=? WHERE decision_digest=?').run(JSON.stringify(request), h.decision.decisionDigest);
    const before = retained(h); await expect(check(h.receiver, id)).rejects.toThrow(); expect(retained(h)).toEqual(before);
  });
  it.each(['body', 'reply', 'write_key', 'payload', 'dispatched_at'])('rejects corrupt accepted %s metadata', async field => {
    const h = fixture(), id = await accepted(h);
    if (field === 'body' || field === 'reply') h.database.prepare(`UPDATE ags_model_peer_transfers_v1 SET ${field}='{}' WHERE packet_id=? AND direction='inbound'`).run(id);
    else h.database.prepare(`UPDATE ags_model_dispatches_v2 SET ${field}=? WHERE dispatch_key=?`).run(field === 'dispatched_at' ? NOW : 'corrupt', h.key);
    const before = retained(h); await expect(check(h.receiver, id)).rejects.toThrow(); expect(retained(h)).toEqual(before);
  });
  it.each(['revision', 'lease-owner', 'lease-state', 'outcome', 'risk-high', 'risk-critical', 'permission', 'prohibition', 'approval'])('rechecks local %s after the last asynchronous request', async kind => {
    const h = fixture(), id = await accepted(h), originalRun = h.workflow.getRun.bind(h.workflow), original = h.workflow.getGuardedRunBinding.bind(h.workflow);
    const receiver = lastAwait(h, () => {
      if (kind === 'revision') vi.spyOn(h.workflow, 'getRun').mockImplementation(run => ({ ...originalRun(run), revision: h.req.binding.revision + 1 }));
      else vi.spyOn(h.workflow, 'getGuardedRunBinding').mockImplementation(run => {
        const b = structuredClone(original(run));
        if (kind === 'lease-owner') b.lease.actorId = 'other';
        if (kind === 'lease-state') b.lease.state = 'released';
        if (kind === 'outcome') b.outcome = { state: 'succeeded' };
        if (kind.startsWith('risk-')) b.proposal.taskEnvelope.riskLevel = kind.slice(5);
        if (kind === 'permission') b.proposal.taskEnvelope.authorization.allowedActions = ['read'];
        if (kind === 'prohibition') b.proposal.taskEnvelope.authorization.prohibitedActions = ['write'];
        if (kind === 'approval') b.proposal.taskEnvelope.authorization.approvalRequired = ['write'];
        return b;
      });
    });
    await expect(check(receiver, id)).rejects.toThrow();
    expect(h.routing.dispatch(h.key)).toMatchObject({ state: 'accepted', revision: 1, dispatched_at: null });
  });
  it.each(['running', 'unknown'])('preserves a competing %s transition on a second SQLite connection', async state => {
    const h = fixture(), id = await accepted(h), db = new DatabaseSync(h.path), other = new ModelRoutingStore(db);
    try {
      const receiver = lastAwait(h, () => other.transition(h.key, 1, state, null, state === 'running' ? NOW : null));
      await expect(check(receiver, id)).rejects.toThrow(/dispatch/iu);
      expect(other.dispatch(h.key)).toMatchObject({ state, revision: 2 });
      expect(h.receiver.journal.get(id, 'inbound').state).toBe('accepted');
    } finally { db.close(); }
  });
  it('rechecks earlier presence expiry against the clock after the final await', async () => {
    const h = fixture(), id = await accepted(h);
    let reads = 0;
    const receiver = h.peer(RECEIVER, { clock: h.now, request: async (...args) => {
      const response = await h.transport(...args);
      if (args[0] === 'presence') {
        reads += 1;
        if (reads === 3) response.presence.leaseUntil = new Date(h.now() + 1).toISOString();
        if (reads === 4) h.advance(2);
      }
      return response;
    } });
    await expect(check(receiver, id)).rejects.toThrow(/presence expired/u);
    expect(h.routing.dispatch(h.key).state).toBe('accepted');
  });
  it('re-reads newly available local capabilities after the final network await', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h);
    const receiver = lastAwait(h, () => vi.spyOn(h.routing, 'capabilities').mockReturnValue([
      seal({ ...h.cap, actorId: 'additional-worker', sessionId: 'additional-session', instanceId: 'additional-instance' }, 'snapshotDigest'),
    ]));
    await expect(check(receiver, id)).rejects.toThrow(); expect(retained(h)).toEqual(before);
  });
  it('fails closed on broker errors without converting acceptance to not-started', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h);
    const receiver = h.peer(RECEIVER, { clock: h.now, request: async () => { throw new Error('offline'); } });
    await expect(check(receiver, id)).rejects.toThrow(); expect(retained(h)).toEqual(before);
  });
  it('re-resolves current catalog/policy after the final await instead of trusting the earlier check', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h), original = ModelRoutingServiceCore.prototype.resolve;
    const receiver = lastAwait(h, () => vi.spyOn(ModelRoutingServiceCore.prototype, 'resolve').mockImplementation(function (...args) {
      const fresh = original.apply(this, args); return { ...fresh, policyDigest: digest('changed-policy'), decisionDigest: digest('changed-decision') };
    }));
    await expect(check(receiver, id)).rejects.toThrow(/selection changed/u); expect(retained(h)).toEqual(before);
  });
  it('checks current audit history even when an accepted packet is already stored', async () => {
    const h = fixture(), req = { ...h.req, role: 'independent-audit', highRisk: true }, decision = resolveV2(req, h.env);
    expect(decision.status).toBe('selected'); h.routing.saveDecision(req, h.env, decision, NOW);
    const signer = new ModelPeerPacketSigner(TOKEN), expiresAt = new Date(h.now() + 60000).toISOString();
    const body = signer.sign({ kind: 'proposal', sender: SENDER, recipient: RECEIVER, issuedAt: NOW, expiresAt,
      contents: JSON.parse(encodePeerAssignment(req, decision)) });
    const id = peerMessageId(body);
    h.receiver.journal.prepare('inbound', decision, body, false, expiresAt);
    const reply = signer.sign({ kind: 'receipt', sender: RECEIVER, recipient: SENDER, issuedAt: NOW, expiresAt,
      contents: { proposalId: id, decisionDigest: decision.decisionDigest, bindingDigest: digest(req.binding), disposition: 'accepted',
        reason: 'HANDOFF_ACCEPTED', executionStarted: false, completed: false } });
    h.receiver.journal.settle(id, 'accepted', reply, 'inbound');
    h.routing.reserveDispatch(decision, { write: true }); h.routing.transition(h.key, 0, 'accepted');
    await expect(check(h.receiver, id)).rejects.toThrow(/auditor participated/u);
    expect(h.routing.dispatch(h.key).state).toBe('accepted');
  });
});
