// Candidate: create retirement evidence (newer live generation) for v272-s0 at a future instant and prune.
import { SessionMessageStore } from "../mcp-server/src/session-message-store.ts";
const [database] = process.argv.slice(2);
const s = new SessionMessageStore(database);
const row = s.database.prepare("SELECT expires_at FROM wake_nonces WHERE session_id = 'v272-s0'").get() as { expires_at: string };
const at = Date.parse(row.expires_at) + 10 * 60_000 + 1000;
const t = { host: "portable", sessionId: "v272-s0" };
s.startPresence({ ...t, instanceId: "new-gen", transport: "portable", wakeVisibility: "silent", canWakeSilently: true,
  deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" } }, at);
s.prune(at);
console.log(JSON.stringify(s.database.prepare("SELECT session_id, state, retired_at FROM wake_nonces ORDER BY rowid").all()));
s.close();
