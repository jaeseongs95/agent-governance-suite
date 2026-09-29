// Audit-only: active wake rows with NULL instance/birth (migrated shape) and a legacy row, after expiry + grace.
import { createHash } from "node:crypto";
import { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } from "../../mcp-server/src/session-message-store.js";
const store = new SessionMessageStore(":memory:");
const T = Date.now() - WAKE_TTL_MS - WAKE_RETIRE_GRACE_MS - 5 * 60_000;
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as Array<"peer-wake" | "tool-boundary">, idleWake: "user-message" as const };
const d = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (n: number) => new Date(n).toISOString();
// null-live: a live birth exists for the identity; null-none: no presence row at all.
store.startPresence({ host: "codex", sessionId: "null-live", instanceId: "i", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: caps });
for (const [sid, state] of [["null-live", "unknown"], ["null-none", "submitted"]]) {
  store.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state) VALUES (?, 'codex', ?, ?, ?)`).run(d(sid), sid, iso(T + WAKE_TTL_MS), state);
}
store.database.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at) VALUES (?, 'codex', 'legacy', ?)`).run(d("legacy"), iso(Date.now() + 60_000));
store.prune();
console.log(JSON.stringify(store.database.prepare("SELECT session_id, state, instance_id, retired_at IS NOT NULL AS retired FROM wake_nonces ORDER BY session_id").all()));
store.close();
