// v2.7.3 code: a production-like DB with many ended/lapsed presence rows plus messages, receipts, wake rows.
import { SessionMessageStore } from "../mcp-server/src/session-message-store.ts";
const [db, nowArg] = process.argv.slice(2); const now = Number(nowArg); const H = 3600_000;
const s = new SessionMessageStore(db);
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as const, idleWake: "silent" as const };
for (let i = 0; i < 292; i++) for (let k = 0; k < 4 + (i % 3); k++) {
  const at = now - (1 + (i % 9)) * 24 * H - k * 60_000;
  s.startPresence({ host: "portable", sessionId: `old-${i}`, instanceId: `old-${i}-${k}`, transport: "portable", wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: { ...caps, supportedInjection: [...caps.supportedInjection] } }, at);
  if (k % 2 === 0) s.endPresence({ host: "portable", sessionId: `old-${i}` }, "session-end", `old-${i}-${k}`, at + 1000);
}
for (let i = 0; i < 5; i++) {
  const target = { host: "portable", sessionId: `old-${i}` }; const sender = { host: "portable", sessionId: `snd-${i}` };
  for (let m = 0; m < 3; m++) { const d = s.prepare({ sender, target, body: `body ${i}-${m}`, ttlSeconds: 86400 }, now - H); s.submitPrepared(sender, d.messageId, now - H); }
}
// wake rows referencing old generations (expired, unobserved)
for (let i = 0; i < 5; i++) {
  const row = s.database.prepare("SELECT instance_id, started_at FROM session_presence WHERE session_id = ? LIMIT 1").get(`old-${i}`) as { instance_id: string; started_at: string };
  s.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, nonce, instance_id, birth_generation, transport, relay_id, attempt_id, dispatch_epoch)
    VALUES (?, 'portable', ?, ?, 'submitted', ?, ?, ?, 'portable', 'r', ?, 1)`).run(`dig-${i}`, `old-${i}`, new Date(now - 5 * 24 * H).toISOString(), `nonce-${i}-abcdefghijklmnopqrstuvw`, row.instance_id, row.started_at, `att-${i}`);
}
s.close(); console.log("made");
