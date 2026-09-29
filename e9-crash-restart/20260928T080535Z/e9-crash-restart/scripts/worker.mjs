// Relay / hook worker processes (one public-path cycle per invocation).
// run: cwd=<worktree>; node --import tsx --import /tmp/ev/scripts/inject.mjs worker.mjs '<json>'
import { appendFileSync, openSync, fsyncSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const input = JSON.parse(process.argv[2]);
const src = `${input.worktree}/mcp-server/src`;
const { requestSessionMessageOnce } = await import(`${src}/session-message-client.ts`);
const point = (name) => globalThis.__agsPoint?.(name);
const req = (op, payload) => requestSessionMessageOnce(op, payload, input.stateDir, 5000);
const out = (value) => { process.stdout.write(JSON.stringify(value) + '\n'); };

async function relay() {
  const { dispatchManagedWake } = await import(`${src}/session-message-relay.ts`);
  const target = input.target;
  const acquired = await req('acquire-relay', { target, transport: 'portable', relayId: input.relayId, pid: process.pid,
    parentPid: input.parentPid, instanceId: input.instanceId });
  point('relay:after-acquire');
  const tick = await req('relay-tick', { target, transport: 'portable', relayId: input.relayId, instanceId: input.instanceId, includePending: true });
  point('relay:after-tick');
  const result = { acquired: acquired.acquired, tick, called: false, start: null, effect: null, outcomeRecorded: null };
  if (!tick.alive || tick.count <= 0) return out(result);
  const request = async (op, payload) => {
    const r = await req(op, payload);
    if (op === 'reserve-wake') { result.reserve = r; point('relay:after-reserve'); }
    if (op === 'start-wake') { result.start = r; point('relay:after-start'); }
    if (op === 'record-wake-outcome') { result.outcomeRecorded = r; point('relay:after-outcome'); }
    return r;
  };
  const port = { capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' },
    dispatch: async (_t, message) => {
      const nonce = /wake:([A-Za-z0-9_-]+)\]/.exec(message)[1];
      const db = new DatabaseSync(join(input.stateDir, 'session-messages.sqlite3'), { readOnly: true });
      let persisted;
      try { persisted = db.prepare('SELECT state, attempt_id, dispatch_epoch FROM wake_nonces WHERE nonce_digest = ?')
        .get(createHash('sha256').update(nonce).digest('hex')); } finally { db.close(); }
      const effect = { sessionId: target.sessionId, nonce, attemptId: result.start?.attempt?.attemptId,
        instanceId: input.instanceId, generation: result.start?.attempt?.generation, epoch: result.start?.attempt?.dispatchEpoch,
        relayId: input.relayId, persisted: persisted ?? null, at: new Date().toISOString() };
      const fd = openSync(input.effectsFile, 'a'); writeSync(fd, JSON.stringify(effect) + '\n'); fsyncSync(fd); closeSync(fd);
      result.effect = effect;
      point('relay:after-effect');
      return input.outcome;
    } };
  result.called = await dispatchManagedWake({ ...target, instanceId: input.instanceId, transport: 'portable' }, input.relayId, port, request);
  out(result);
}

async function hook() {
  const { adaptHostInput } = await import(`${src}/host-input-adapter.ts`);
  const { recordWakeHookObservation } = await import(`${src}/session-message-wake-port.ts`);
  const target = input.target;
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
    prompt: `[agent-governance-suite:wake:${input.nonce}]` }, target.host).observation;
  const sourceReceiptId = recordWakeHookObservation(observation);
  // Tell the parent which receipt exists before we try the broker.
  appendFileSync(input.receiptsFile, JSON.stringify({ nonce: input.nonce, sessionId: target.sessionId, sourceReceiptId, at: new Date().toISOString() }) + '\n');
  point('hook:after-receipt');
  const payload = { target, maxMessages: 1, maxBodyChars: 4096, observation, sourceReceiptId };
  let result; let retried = false; let firstError = null;
  try { result = await req('claim-host-wake', payload); }
  catch (error) {
    // Same one-retry-after-broker-recovery behaviour as sessionMessageRequest, same payload/receipt.
    firstError = String(error?.message ?? error); retried = true;
    const deadline = Date.now() + Number(process.env.AGS_HOOK_WAIT_MS || 15000);
    while (Date.now() < deadline) {
      try { await req('ping', {}); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    result = await req('claim-host-wake', payload);
  }
  point('hook:after-claim');
  out({ sourceReceiptId, result, retried, firstError });
}

try { await (input.role === 'relay' ? relay() : hook()); process.exit(0); }
catch (error) { out({ error: String(error?.message ?? error) }); process.exit(3); }
