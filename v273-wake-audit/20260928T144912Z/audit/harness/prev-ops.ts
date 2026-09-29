// v2.7.2 source store (== v2.7.2 dist semantics) operating on a schema-1 DB: reserve for a retired target, prune, claim.
import { SessionMessageStore } from "../mcp-server/src/session-message-store.ts";
const [database] = process.argv.slice(2);
const s = new SessionMessageStore(database);
const t = { host: "portable", sessionId: "v272-s0" };
const now = Date.now();
s.startPresence({ ...t, instanceId: "prev-gen", transport: "portable", wakeVisibility: "silent", canWakeSilently: true,
  deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" } }, now);
s.acquireRelay({ ...t, transport: "portable", relayId: "prev-relay", pid: process.pid, parentPid: process.pid }, now);
const r = s.reserveManagedWake({ ...t, nonce: "prev-broker-nonce-abcdefghijklmnopq", instanceId: "prev-gen", transport: "portable", relayId: "prev-relay" }, now);
s.prune(now + 7200_000);
console.log(JSON.stringify({ reserved: r.dispatch, rows: s.database.prepare("SELECT session_id, state FROM wake_nonces ORDER BY rowid").all(),
  version: (s.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version }));
s.close();
