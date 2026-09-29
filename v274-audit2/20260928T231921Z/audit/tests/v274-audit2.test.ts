// Re-audit of 240e0ca5 (F1/F2 fixes). Not product code.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { isBoundedIdentity } from "../../mcp-server/src/session-message-protocol.js";

const broker = fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url));
const caps = { supportedInjection: ["peer-wake", "tool-boundary"] as Array<"peer-wake" | "tool-boundary">, idleWake: "silent" as const };
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const t of cleanup.splice(0).reverse()) await t(); });
const t = (sessionId: string, host = "portable") => ({ host, sessionId });
async function start(seed: (s: SessionMessageStore) => void) {
  const d = mkdtempSync(path.join(tmpdir(), "ags-v274-audit2-")); cleanup.push(() => rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const s = new SessionMessageStore(path.join(d, "session-messages.sqlite3")); try { seed(s); } finally { s.close(); }
  const child = spawn(process.execPath, ["--import", "tsx", broker, "--state-directory", d], { windowsHide: true, stdio: "ignore" });
  cleanup.push(async () => { try { if (child.pid) process.kill(child.pid, "SIGCONT"); } catch { /* gone */ }
    if (child.exitCode === null && child.signalCode === null) { const e = once(child, "exit"); child.kill("SIGKILL"); await e; }
    const ep = path.join(d, "endpoint.json"); if (existsSync(ep)) { try { process.kill((JSON.parse(readFileSync(ep, "utf8")) as { pid: number }).pid, "SIGKILL"); } catch { /* gone */ } } });
  await waitForSessionMessageBrokerReady(d, child, 10_000);
  return { d, child };
}
const born = (s: SessionMessageStore, id: string) => s.startPresence({ host: "portable", sessionId: id, instanceId: `i-${id}`, transport: "portable", wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: caps }, Date.now());

it("P1 isBoundedIdentity matches the old store regexes on a corpus including non-strings coerced by RegExp.test", () => {
  const oldHost = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/; const oldSession = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
  const corpus = ["a", "A.b:c-d_e", "", " a", "a b", "é", "x".repeat(64), "x".repeat(65), "x".repeat(200), "x".repeat(201), "-a", "a\n", "undefined"];
  for (const h of corpus) for (const s of corpus) expect(isBoundedIdentity({ host: h, sessionId: s })).toBe(oldHost.test(h) && oldSession.test(s));
  const store = new SessionMessageStore(":memory:"); cleanup.push(() => store.close());
  expect(() => store.presence(t("has space"))).toThrow("host and sessionId must use bounded identifier characters.");
});

it("P2 duplicates and a bad identity inside one batch: good ones resolve, bad one unanswered, duplicates answered consistently", async () => {
  const { d } = await start((s) => { for (const id of ["a", "b", "c"]) born(s, id); });
  const res = await new SessionMessageService(d).listPresence([t("a"), t("has space"), t("a"), t("b"), t("c"), t("b")]);
  console.log("AUDIT-P2", JSON.stringify({ ok: res.ok, sessions: res.data!.sessions.map((x) => `${x.sessionId}:${x.state}`), unanswered: res.data!.unanswered }));
  expect(res.ok).toBe(true); expect(res.data!.unanswered).toEqual([t("has space")]);
  expect(new Set(res.data!.sessions.map((x) => x.state))).toEqual(new Set(["online"]));
});

it("P3 broker killed: every session unanswered (2.7.3-equivalent unknown/null), with total latency recorded", async () => {
  const { d, child } = await start((s) => { for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) born(s, id); });
  const e = once(child, "exit"); child.kill("SIGKILL"); await e;
  // Make restart impossible: the state directory is replaced by a file, so the client cannot relaunch a broker.
  rmSync(d, { recursive: true, force: true }); await import("node:fs").then((fs) => fs.writeFileSync(d, "blocked"));
  cleanup.push(() => rmSync(d, { force: true }));
  const st = performance.now();
  const res = await new SessionMessageService(d).listPresence(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((x) => t(x)));
  const ms = Math.round(performance.now() - st);
  console.log("AUDIT-P3", JSON.stringify({ ok: res.ok, sessions: res.data!.sessions.length, unanswered: res.data!.unanswered!.length, ms, batches: 3 }));
  expect(res.data!.sessions).toHaveLength(0); expect(res.data!.unanswered).toHaveLength(9);
}, 180_000);

it("P4 broker hung (SIGSTOP): per-batch deadlines add up; latency recorded for 3 batches", async () => {
  const { d, child } = await start((s) => { for (const id of ["a", "b", "c", "d", "e", "f", "g", "h", "i"]) born(s, id); });
  process.kill(child.pid!, "SIGSTOP");
  const st = performance.now();
  const res = await new SessionMessageService(d).listPresence(["a", "b", "c", "d", "e", "f", "g", "h", "i"].map((x) => t(x)));
  const ms = Math.round(performance.now() - st);
  process.kill(child.pid!, "SIGCONT");
  console.log("AUDIT-P4", JSON.stringify({ ok: res.ok, sessions: res.data!.sessions.length, unanswered: res.data!.unanswered!.length, ms, batches: 3, perBatchMs: Math.round(ms / 3) }));
  expect(res.data!.unanswered!.length + res.data!.sessions.length).toBe(9);
}, 240_000);
