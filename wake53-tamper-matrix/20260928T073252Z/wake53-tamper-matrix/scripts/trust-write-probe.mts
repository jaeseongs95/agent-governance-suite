// Probe: does the wake receipt verifier write to the trust DB on reject paths? does it recreate a deleted key?
import { mkdtempSync, readFileSync, existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path"; import { tmpdir } from "node:os";
const WT = process.env.WT!;
const { recordWakeHookObservation, createWakeHookObservationReader } = await import(`${WT}/mcp-server/src/session-message-wake-port.ts`);
const dir = mkdtempSync(path.join(tmpdir(), "j1-probe-")); const tp = path.join(dir, "trust.sqlite3");
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = tp;
const obs = { host: "codex", sessionId: "probe", kind: "user-input", actor: { kind: "main", observedBy: "codex:hook-payload", assurance: "observed" }, wakeCandidates: ["A".repeat(32)], wakeOnly: true };
const T = Date.now(); const rid = recordWakeHookObservation(obs, T);
const snap = () => { const b = readFileSync(tp); return { size: b.length, changeCounter: b.readUInt32BE(24), versionValidFor: b.readUInt32BE(92), wal: existsSync(tp + "-wal") ? statSync(tp + "-wal").size : null, mode: (statSync(tp).mode & 0o777).toString(8) }; };
const keys = () => { const d = new DatabaseSync(tp, { readOnly: true }); try { return d.prepare("SELECT key, substr(value,1,6) AS v, updated_at FROM trust_metadata").all(); } finally { d.close(); } };
console.log("after-record", JSON.stringify(snap()), JSON.stringify(keys()));
const r = createWakeHookObservationReader(tp);
console.log("verify(wrong receiptId)=", r.verifyObservation({ host: "codex", sessionId: "probe" }, obs, "source-nope", T + 1), JSON.stringify(snap()));
console.log("verify(valid)=", r.verifyObservation({ host: "codex", sessionId: "probe" }, obs, rid, T + 1), JSON.stringify(snap()));
const d = new DatabaseSync(tp); d.exec("DELETE FROM trust_metadata WHERE key='trust-signing-key'"); d.close();
console.log("key deleted", JSON.stringify(keys()));
console.log("verify(valid, key deleted)=", r.verifyObservation({ host: "codex", sessionId: "probe" }, obs, rid, T + 1), JSON.stringify(snap()), "keys-after:", JSON.stringify(keys()));
