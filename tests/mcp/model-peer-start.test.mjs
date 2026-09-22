import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelRoutingStore } from '../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ModelRoutingPeerSession } from '../../mcp-server/src/model-routing-peer-session.js';
import { ModelRoutingWorkflowBridge } from '../../mcp-server/src/model-routing-workflow.js';
import { ModelPeerPacketSigner } from '../../mcp-server/src/model-peer-packet.js';
import { seal } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { RECEIVER, TOKEN } from './peer-handoff-fixtures.mjs';
import { fixture, accepted, retained, lastAwait } from './peer-execution-fixtures.mjs';
import { NOW } from '../coordinate-subagents/model-routing-v2/fixtures.mjs';

afterEach(() => vi.restoreAllMocks());

describe('atomic accepted peer execution start (no native worker)', () => {
  it('claims once, timestamps the claim rather than the earlier preflight, and changes only the dispatch', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h);
    const checked = await h.receiver.preflight(id); h.advance(25);
    const calls = h.calls.length;
    const result = await h.receiver.start(id, checked.dispatchRevision);
    expect(result).toEqual({ packetId: id, decisionDigest: h.decision.decisionDigest, dispatchKey: h.key,
      dispatchRevision: 2, dispatchState: 'running', dispatchedAt: new Date(h.now()).toISOString(), startClaimAcquired: true,
      requiresNativeExecutor: true, executionStarted: false, executionState: 'not-observed', completed: false,
      executionAuthorized: false, trustedGateSatisfied: false });
    expect(retained(h)).toEqual({ ...before, dispatch: { ...before.dispatch, state: 'running', revision: 2, dispatched_at: result.dispatchedAt } });
    expect(h.calls.slice(calls).every(op => ['ping', 'list-model-capabilities', 'presence'].includes(op))).toBe(true);
    const claimed = retained(h);
    for (const revision of [1, 2]) await expect(h.receiver.start(id, revision)).rejects.toThrow();
    await expect(h.receiver.preflight(id)).rejects.toThrow();
    expect(retained(h)).toEqual(claimed);
  });
  it('always revalidates from stored acceptance, even without an earlier read-only preflight', async () => {
    const h = fixture(), id = await accepted(h);
    expect((await h.receiver.start(id, 1)).startClaimAcquired).toBe(true);
    expect(h.routing.dispatch(h.key)).toMatchObject({ state: 'running', revision: 2, dispatched_at: NOW });
  });
  it.each([undefined, null, '1', 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])('rejects invalid revision %s before acquiring a claim', async revision => {
    const h = fixture(), id = await accepted(h), before = retained(h), calls = h.calls.length;
    await expect(h.receiver.start(id, revision)).rejects.toThrow();
    expect(retained(h)).toEqual(before); expect(h.calls.length).toBe(calls);
  });
  it('rejects a stale but well-formed expected revision', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h);
    await expect(h.receiver.start(id, 2)).rejects.toThrow(/revision/u);
    expect(retained(h)).toEqual(before);
  });
  it('only one of two independent database connections acquires a claim after both preflights pass', async () => {
    const h = fixture(), id = await accepted(h), database = new DatabaseSync(h.path), store = new ModelRoutingStore(database);
    try {
      const second = new ModelRoutingPeerSession({ store, workflowBridge: new ModelRoutingWorkflowBridge(h.workflow, store),
        identity: RECEIVER, actorId: h.actorId, signer: new ModelPeerPacketSigner(TOKEN), stateDirectory: h.directory,
        clock: h.now, request: h.transport, timeoutMs: 10000 });
      const checks = await Promise.all([h.receiver.preflight(id), second.preflight(id)]);
      expect(checks.every(result => result.preflightPassed && result.dispatchRevision === 1)).toBe(true);
      const results = await Promise.allSettled([h.receiver.start(id, 1), second.start(id, 1)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(store.dispatch(h.key)).toMatchObject({ state: 'running', revision: 2, dispatched_at: NOW });
    } finally { database.close(); }
  });
  it('does not reuse a passing preflight after another connection makes the dispatch unknown', async () => {
    const h = fixture(), id = await accepted(h), checked = await h.receiver.preflight(id), db = new DatabaseSync(h.path);
    try {
      new ModelRoutingStore(db).transition(h.key, 1, 'unknown'); const before = retained(h);
      await expect(h.receiver.start(id, checked.dispatchRevision)).rejects.toThrow(); expect(retained(h)).toEqual(before);
    } finally { db.close(); }
  });
  it('rechecks the workflow after obtaining the write lock, not just after the network awaits', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h), exec = h.database.exec.bind(h.database);
    const original = h.workflow.getGuardedRunBinding.bind(h.workflow);
    vi.spyOn(h.database, 'exec').mockImplementation(sql => {
      exec(sql);
      if (sql.startsWith('BEGIN IMMEDIATE')) vi.spyOn(h.workflow, 'getGuardedRunBinding').mockImplementation(runId => {
        const binding = structuredClone(original(runId)); binding.proposal.taskEnvelope.authorization.approvalRequired = ['write']; return binding;
      });
    });
    await expect(h.receiver.start(id, 1)).rejects.toThrow(/approval/u);
    vi.restoreAllMocks(); expect(retained(h)).toEqual(before);
    expect(h.database.isTransaction).toBe(false);
  });
  it('rechecks expiry after lock acquisition and leaves acceptance intact on failure', async () => {
    const h = fixture(), id = await accepted(h), before = retained(h), exec = h.database.exec.bind(h.database);
    vi.spyOn(h.database, 'exec').mockImplementation(sql => { exec(sql); if (sql.startsWith('BEGIN IMMEDIATE')) h.advance(60000); });
    await expect(h.receiver.start(id, 1)).rejects.toThrow(/expired/u);
    expect(retained(h)).toEqual(before); expect(h.database.isTransaction).toBe(false);
  });
  it('holds the SQLite write lock throughout the final synchronous governance validation', async () => {
    const h = fixture(), id = await accepted(h), database = new DatabaseSync(h.path), exec = h.database.exec.bind(h.database);
    let locked = false, checkedInsideLock = false;
    const original = h.bridge.validatePeerExecutionPreflight.bind(h.bridge);
    vi.spyOn(h.database, 'exec').mockImplementation(sql => { exec(sql); locked = sql.startsWith('BEGIN IMMEDIATE'); });
    vi.spyOn(h.bridge, 'validatePeerExecutionPreflight').mockImplementation((...args) => {
      if (locked) {
        checkedInsideLock = true;
        expect(() => database.prepare("UPDATE ags_model_dispatches_v2 SET state='unknown' WHERE dispatch_key=?").run(h.key)).toThrow(/locked|busy/u);
      }
      return original(...args);
    });
    try { expect((await h.receiver.start(id, 1)).startClaimAcquired).toBe(true); expect(checkedInsideLock).toBe(true); }
    finally { database.close(); }
  });
  it('preserves a running write exclusion across replacement attempts and models', async () => {
    const h = fixture(), id = await accepted(h); await h.receiver.start(id, 1);
    const replacement = seal({ ...h.decision, binding: { ...h.req.binding, assignmentId: 'replacement', attemptId: 'new-attempt', revision: 2 } }, 'decisionDigest');
    expect(() => h.routing.reserveDispatch(replacement, { write: true })).toThrow(/AMBIGUOUS_WRITE_ACTIVE/u);
    h.routing.transition(h.key, 2, 'unknown'); const before = retained(h);
    await expect(h.receiver.start(id, 3)).rejects.toThrow(); expect(retained(h)).toEqual(before);
    expect(() => h.routing.reserveDispatch(replacement, { write: true })).toThrow(/AMBIGUOUS_WRITE_ACTIVE/u);
  });
  it('does not await network I/O while the routing writer lock is held', async () => {
    const h = fixture(), id = await accepted(h), exec = h.database.exec.bind(h.database); let locked = false;
    vi.spyOn(h.database, 'exec').mockImplementation(sql => { exec(sql); locked = sql.startsWith('BEGIN IMMEDIATE'); });
    const receiver = h.peer(RECEIVER, { clock: h.now, request: async (...args) => { expect(locked).toBe(false); return h.transport(...args); } });
    expect((await receiver.start(id, 1)).startClaimAcquired).toBe(true);
  });
  it('does not roll back another connection when journal bytes change just before the claim', async () => {
    const h = fixture(), id = await accepted(h), database = new DatabaseSync(h.path);
    try {
      const receiver = lastAwait(h, () => database.prepare("UPDATE ags_model_peer_transfers_v1 SET reply='{}' WHERE packet_id=? AND direction='inbound'").run(id));
      await expect(receiver.start(id, 1)).rejects.toThrow();
      expect(h.receiver.journal.get(id, 'inbound').reply).toBe('{}');
      expect(h.routing.dispatch(h.key)).toMatchObject({ state: 'accepted', revision: 1, dispatched_at: null });
    } finally { database.close(); }
  });
});
