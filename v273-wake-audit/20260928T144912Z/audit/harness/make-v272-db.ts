// Run from the v2.7.2 (base) worktree with tsx: builds a real v2.7.2-shaped DB with the released store code.
import { SessionMessageStore } from "../mcp-server/src/session-message-store.ts";
import { DatabaseSync } from "node:sqlite";
const [database, bulkArg] = process.argv.slice(2);
const bulk = Number(bulkArg ?? 0);
const s = new SessionMessageStore(database);
const caps = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" } as const;
const now = Date.now() - 3 * 3600_000;
const mk = (sessionId: string, instanceId: string, at: number) => {
  const t = { host: "portable", sessionId };
  s.startPresence({ ...t, instanceId, transport: "portable", wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: caps }, at);
  s.acquireRelay({ ...t, transport: "portable", relayId: `${instanceId}-r`, pid: process.pid, parentPid: process.pid }, at);
  return t;
};
const sender = { host: "portable", sessionId: "v272-sender" };
for (const [i, outcome] of (["submitted", "accepted-or-unknown", "started", "definite-failure", "observed"] as const).entries()) {
  const t = mk(`v272-s${i}`, `v272-i${i}`, now);
  s.send({ sender, target: t, messageId: `v272-body-${i}`, body: `body ${i}`, ttlSeconds: 86400 }, now);
  const r = s.reserveManagedWake({ ...t, nonce: `v272-nonce-${i}-abcdefghijklmnopqrstu`, instanceId: `v272-i${i}`, transport: "portable", relayId: `v272-i${i}-r` }, now);
  const st = s.startManagedWake(r.attempt!, now + 1);
  if (outcome === "observed") continue;
  if (outcome !== "started") s.recordManagedWakeOutcome(st.attempt!, outcome, now + 2);
}
s.reserveWake({ host: "portable", sessionId: "v272-legacy" } as never, "legacy-nonce-abcdefghijklmnop", now);
s.close();
if (bulk > 0) {
  const db = new DatabaseSync(database);
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state) VALUES (?, 'portable', ?, ?, 'legacy')");
  const far = new Date(Date.now() + 86400_000 * 365).toISOString();
  for (let i = 0; i < bulk; i++) ins.run(`bulk-${i.toString().padStart(8, "0")}`, `bulk-session-${i}`, far);
  db.exec("COMMIT"); db.close();
}
console.log("created", database);
