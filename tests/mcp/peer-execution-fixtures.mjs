/** Shared real-workflow/SQLite fixture for read-only checks and atomic local starts. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, onTestFinished, vi } from 'vitest';
import { SessionMessageStore } from '../../mcp-server/src/session-message-store.js';
import { SessionModelCapabilityStore, capabilitySigner, MODEL_CAPABILITY_FEATURE } from '../../mcp-server/src/session-model-capabilities.js';
import { digest } from '../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { createPeerWorkflow, SENDER, RECEIVER, TOKEN, PEER_NOW as NOW } from './peer-handoff-fixtures.mjs';

export function fixture() {
  const cleanups = [];
  onTestFinished(() => { while (cleanups.length) cleanups.pop()(); });
  const directory = mkdtempSync(join(tmpdir(), 'ags-peer-preflight-'));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse(NOW);
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const h = createPeerWorkflow(directory, { now }); cleanups.push(h.close);
  const sessions = new SessionMessageStore(join(directory, 'messages.sqlite3')); cleanups.push(() => sessions.close());
  for (const identity of [SENDER, RECEIVER]) sessions.startPresence({ ...identity, transport: 'fixture', wakeVisibility: 'none', canWakeSilently: false }, now);
  const caps = new SessionModelCapabilityStore(sessions, capabilitySigner(TOKEN));
  const publish = snapshot => caps.publish(capabilitySigner(TOKEN).issue('capability', {
    schemaVersion: '1.0.0', identity: RECEIVER, snapshot,
  }, { issuedAt: snapshot.observedAt, expiresAt: snapshot.expiresAt }), now);
  publish(h.cap);
  const calls = [];
  const transport = async (operation, payload) => {
    calls.push(operation);
    switch (operation) {
      case 'ping': return { protocolVersion: '1.0.0', capabilities: [MODEL_CAPABILITY_FEATURE] };
      case 'list-model-capabilities': return caps.list(payload, now);
      case 'presence': return { presence: sessions.presence(payload.target, now) };
      case 'send': return sessions.send(payload, now);
      case 'status': return { status: sessions.status(payload.sender, payload.messageId, now) };
      default: throw new Error(`Unexpected operation: ${operation}`);
    }
  };
  const sender = h.peer(SENDER, { request: transport, clock: () => now });
  const receiver = h.peer(RECEIVER, { request: transport, clock: () => now });
  const claim = identity => sessions.claim(identity, now, { maxMessages: 10, maxBodyChars: 32768 });
  return { ...h, sessions, caps, sender, receiver, transport, calls, claim, publish, now: () => now,
    advance: ms => { now += ms; }, key: digest({ binding: h.req.binding }) };
}
export async function accepted(h) {
  const sent = await h.sender.send(h.decision.decisionDigest);
  expect((await h.receiver.receive(h.claim(RECEIVER)[0])).handoffState).toBe('accepted');
  return sent.packetId;
}
export function retained(h) {
  return {
    dispatch: h.routing.dispatch(h.key), run: h.workflow.getRun(h.run.runId), guarded: h.workflow.getGuardedRunBinding(h.run.runId),
    transfers: h.database.prepare('SELECT * FROM ags_model_peer_transfers_v1 ORDER BY packet_id,direction').all(),
    records: h.database.prepare('SELECT * FROM ags_model_applications_v2').all(),
    receipts: h.database.prepare('SELECT * FROM ags_model_receipts_v1').all(),
  };
}
export function lastAwait(h, change) {
  let reads = 0;
  return h.peer(RECEIVER, { clock: h.now, request: async (...args) => {
    const result = await h.transport(...args);
    if (args[0] === 'presence' && ++reads === 4) change(result);
    return result;
  } });
}
