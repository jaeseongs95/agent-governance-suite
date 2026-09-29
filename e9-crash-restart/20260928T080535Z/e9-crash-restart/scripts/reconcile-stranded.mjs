// Tries the e9 reconcile op on the attempt stranded by the >TTL outage (copy of the repro DB).
import { readFileSync } from 'node:fs';
const dir = process.argv[2];
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = `${dir}/trust.sqlite3`;
const { SessionMessageStore } = await import('/tmp/e9/mcp-server/src/session-message-store.ts');
const { dispatchSessionMessageBrokerOperation: dispatch } = await import('/tmp/e9/mcp-server/src/session-message-broker.ts');
const store = new SessionMessageStore(`${dir}/session-messages.sqlite3`);
const receipts = readFileSync(`${dir}/receipts.jsonl`, 'utf8').trim().split('\n').map(JSON.parse);
const rows = store.database.prepare("SELECT session_id, instance_id, attempt_id, nonce, state, late_observed_at, observed_at FROM wake_nonces WHERE state IN ('submitted','unknown','started')").all();
for (const row of rows) {
  const r = receipts.find((x) => x.nonce === row.nonce);
  console.log('row', JSON.stringify(row), 'receipt', r?.sourceReceiptId ?? null);
  if (!r) continue;
  try { console.log('reconcile ->', JSON.stringify(dispatch(store, 'reconcile-wake-observation', { target: { host: 'portable', sessionId: row.session_id }, attemptId: row.attempt_id, sourceReceiptId: r.sourceReceiptId }))); }
  catch (e) { console.log('reconcile error', e.message); }
  console.log('after', JSON.stringify(store.database.prepare('SELECT state, late_observed_at, observed_at FROM wake_nonces WHERE attempt_id = ?').get(row.attempt_id)));
}
console.log('wake-status', JSON.stringify(dispatch(store, 'wake-status', { target: { host: 'portable', sessionId: 'wake-D' } })));
