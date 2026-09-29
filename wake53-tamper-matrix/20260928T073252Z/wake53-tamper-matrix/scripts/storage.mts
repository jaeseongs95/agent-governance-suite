// Storage failure harness. Modes:
//   setup <dir> <base> [crash]  : create session DB + trust DB, managed wake in <base>, receipt; write meta.json. crash => exit w/o close (leave WAL)
//   claim <dir> [dtMs]          : open store, claimHostWake at T+dt; print JSON result/error (never creates trust DB: reader checks existsSync)
//   dump <dir>                  : print wake_nonces + messages rows (readOnly)
import { createHash } from "node:crypto"; import { readFileSync, writeFileSync } from "node:fs"; import { DatabaseSync } from "node:sqlite"; import path from "node:path";
const WT = process.env.WT!; const [mode, dir, arg] = process.argv.slice(2);
const { SessionMessageStore } = await import(`${WT}/mcp-server/src/session-message-store.ts`);
const { recordWakeHookObservation, createWakeHookObservationReader } = await import(`${WT}/mcp-server/src/session-message-wake-port.ts`);
const dbPath = path.join(dir, "session-messages.sqlite3"); const tp = process.env.TRUST_PATH || path.join(dir, "trust.sqlite3");
const CAPS = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" };
if (mode === "setup") {
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = tp; const T = Date.now(); const target = { host: "codex", sessionId: "storage-s1" };
  const nonce = createHash("sha256").update(dir).digest("base64url").slice(0, 32);
  const store = new SessionMessageStore(dbPath);
  store.startPresence({ ...target, instanceId: "inst-1", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, deliveryCapabilities: CAPS }, T);
  store.acquireRelay({ ...target, transport: "codex-queue", relayId: "relay-1", pid: process.pid, parentPid: process.pid }, T);
  store.send({ sender: { host: "p", sessionId: "sender-1" }, target, messageId: "storage-body-1", body: "b" }, T);
  const r = store.reserveManagedWake({ ...target, nonce, instanceId: "inst-1", transport: "codex-queue", relayId: "relay-1" }, T);
  const st = store.startManagedWake(r.attempt, T + 1);
  if (arg !== "started") store.recordManagedWakeOutcome(st.attempt, arg === "submitted" ? "submitted" : "accepted-or-unknown", T + 2);
  const obs = { host: "codex", sessionId: target.sessionId, kind: "user-input", actor: { kind: "main", observedBy: "codex:hook-payload", assurance: "observed" }, wakeCandidates: [nonce], wakeOnly: true };
  const receipt = recordWakeHookObservation(obs, T + 3);
  writeFileSync(path.join(dir, "..", path.basename(dir) + ".meta.json"), JSON.stringify({ T, target, obs, receipt }));
  if (process.argv[5] === "crash") process.exit(0); // leave WAL un-checkpointed
  store.close();
} else if (mode === "claim") {
  const meta = JSON.parse(readFileSync(path.join(dir, "..", path.basename(dir) + ".meta.json"), "utf8"));
  const out: any = { phase: "open" };
  try {
    const store = new SessionMessageStore(dbPath); out.phase = "claim";
    try { const r = store.claimHostWake(meta.target, meta.obs, meta.receipt, createWakeHookObservationReader(tp), meta.T + Number(arg ?? 10));
      Object.assign(out, { recognized: r.recognized, messages: r.messages.length, managed: r.binding !== null }); }
    finally { try { store.close(); } catch (e: any) { out.closeError = e.message; } }
  } catch (e: any) { out.error = `${e.code ?? ""} ${e.errcode ?? ""} ${e.message}`.trim().slice(0, 300); }
  console.log(JSON.stringify(out));
} else if (mode === "dump") {
  const d = new DatabaseSync(dbPath, { readOnly: true });
  try { console.log(JSON.stringify({ wake: d.prepare("SELECT state, instance_id, birth_generation, consumed_at, observed_at, late_observed_at FROM wake_nonces").all(),
    msgs: d.prepare("SELECT message_id, claimed_at, delivery_attempts, acknowledged_at FROM messages").all() })); } catch (e: any) { console.log(JSON.stringify({ dumpError: e.message })); } finally { d.close(); }
}
