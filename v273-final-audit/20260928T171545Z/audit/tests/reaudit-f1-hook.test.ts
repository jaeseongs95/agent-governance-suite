// Re-audit (651f5ec): hook-level F1/F4 behavior with a real source broker. Not product code.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { SessionMessageStore, WAKE_RETIRE_GRACE_MS, WAKE_TTL_MS } from "../../mcp-server/src/session-message-store.js";

const broker = fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) {
    const endpoint = path.join(d, "endpoint.json");
    if (existsSync(endpoint)) { try { process.kill((JSON.parse(readFileSync(endpoint, "utf8")) as { pid: number }).pid); } catch { /* gone */ } }
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});
async function setup() {
  const d = mkdtempSync(path.join(tmpdir(), "reaudit-hook-")); dirs.push(d);
  const child = spawn(process.execPath, ["--import", "tsx", broker, "--state-directory", d], { windowsHide: true, stdio: "ignore" });
  await waitForSessionMessageBrokerReady(d, child, 5000);
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", d);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(d, "trust.sqlite3"));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "1");
  return d;
}
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as const, idleWake: "user-message" as const };
function seed(d: string, host: string, sessionId: string, withCurrent: boolean) {
  const target = { host, sessionId };
  const store = new SessionMessageStore(path.join(d, "session-messages.sqlite3"));
  const oldNonce = `${sessionId}-old-nonce-abcdefghijklmnop`; const curNonce = `${sessionId}-cur-nonce-abcdefghijklmnop`;
  try {
    const base = Date.now() - WAKE_TTL_MS - WAKE_RETIRE_GRACE_MS - 60_000;
    const live = (instanceId: string, at: number) => {
      store.startPresence({ ...target, instanceId, transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false,
        deliveryCapabilities: { supportedInjection: [...caps.supportedInjection], idleWake: caps.idleWake } }, at);
      store.acquireRelay({ ...target, transport: "codex-queue", relayId: `${instanceId}-relay`, pid: process.pid, parentPid: process.pid }, at);
    };
    live("old", base);
    store.send({ sender: { host: "portable", sessionId: "s" }, target, messageId: `${sessionId}-body`, body: "current body", ttlSeconds: 86400 }, base);
    const r = store.reserveManagedWake({ ...target, nonce: oldNonce, instanceId: "old", transport: "codex-queue", relayId: "old-relay" }, base);
    store.recordManagedWakeOutcome(store.startManagedWake(r.attempt!, base + 1).attempt!, "submitted", base + 2);
    const now = Date.now(); live("new", now);
    if (withCurrent) {
      const r2 = store.reserveManagedWake({ ...target, nonce: curNonce, instanceId: "new", transport: "codex-queue", relayId: "new-relay" }, now);
      store.recordManagedWakeOutcome(store.startManagedWake(r2.attempt!, now + 1).attempt!, "submitted", now + 2);
    }
    expect((store.database.prepare("SELECT state FROM wake_nonces WHERE nonce = ?").get(oldNonce) as { state: string }).state).toBe("expired-unobserved");
  } finally { store.close(); }
  return { target, oldNonce, curNonce };
}
const prompt = (sessionId: string, nonces: string[]) => ({ hook_event_name: "UserPromptSubmit", session_id: sessionId, agent_id: "",
  prompt: nonces.map((n) => `[agent-governance-suite:wake:${n}]`).join("\n") });

for (const host of ["codex", "claude-code"] as const) {
  it(`${host}: mixed retired+current prompt delivers the current body and is not blocked`, async () => {
    const d = await setup(); const s = seed(d, host, `mixed-${host}`, true);
    const out = await handleSessionMessageHook(prompt(s.target.sessionId, [s.oldNonce, s.curNonce]), host);
    expect(out).not.toMatchObject({ decision: "block" });
    expect(JSON.stringify(out)).toContain("current body");
    const store = new SessionMessageStore(path.join(d, "session-messages.sqlite3"));
    try {
      const rows = store.database.prepare("SELECT nonce, state, late_observed_at, observed_at FROM wake_nonces WHERE session_id = ? ORDER BY rowid").all(s.target.sessionId) as Array<Record<string, unknown>>;
      expect(rows[0]).toMatchObject({ state: "expired-unobserved", observed_at: null }); expect(rows[0]!.late_observed_at).toEqual(expect.any(String));
      expect(rows[1]).toMatchObject({ state: "observed", late_observed_at: null });
    } finally { store.close(); }
    // Replay: no second claim, not blocked (body is under claim lease).
    const again = await handleSessionMessageHook(prompt(s.target.sessionId, [s.oldNonce, s.curNonce]), host);
    expect(JSON.stringify(again)).not.toContain("current body");
    expect(again).not.toMatchObject({ decision: "block" });
  }, 30_000);

  it(`${host}: retired-only prompt is blocked only on the blocking-capable host (unchanged from e739090)`, async () => {
    const d = await setup(); const s = seed(d, host, `only-${host}`, false);
    const out = await handleSessionMessageHook(prompt(s.target.sessionId, [s.oldNonce]), host);
    if (host === "codex") expect(out).toMatchObject({ decision: "block" }); else expect(out).toEqual({});
    const store = new SessionMessageStore(path.join(d, "session-messages.sqlite3"));
    try { expect(store.pendingCount(s.target)).toBe(1); } finally { store.close(); }
  }, 30_000);
}
