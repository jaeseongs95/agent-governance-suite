// Audit probe: what a broker (<repo> source) does when a client keeps sending after its request passed the 32 KB limit.
// Usage: node --import tsx flood-probe.mts <repo> <label> <log.jsonl>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import tls from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, label, log] = process.argv.slice(2);
const client = await import(pathToFileURL(path.join(repo!, "mcp-server/src/session-message-client.ts")).href);
const state = await mkdtemp(path.join(tmpdir(), "ags-audit-flood-"));
const child = spawn(process.execPath, ["--import", "tsx", path.join(repo!, "mcp-server/src/session-message-broker.ts"), "--state-directory", state],
  { windowsHide: true, stdio: "ignore" });
const mem = () => { const s = readFileSync(`/proc/${child.pid}/status`, "utf8"); const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(s)?.[1]);
  return { rssKb: kb("VmRSS"), hwmKb: kb("VmHWM") }; };
async function flood(mode: "burst" | "trickle", totalBytes: number) {
  const endpoint = JSON.parse(await readFile(path.join(state, "endpoint.json"), "utf8"));
  const ca = await readFile(path.join(state, "broker-cert.pem"), "utf8");
  const socket = tls.connect({ host: "[REDACTED]", port: endpoint.port, ca, servername: "localhost", minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
    checkServerIdentity: (_h, c) => c.fingerprint256 === endpoint.certificateFingerprint256 ? undefined : new Error("pin") });
  await once(socket, "secureConnect");
  const started = performance.now(); let received = ""; let written = 0; let closedAt: number | null = null; let endAt: number | null = null; let error: string | null = null;
  socket.on("data", (c) => { received += c.toString("utf8"); });
  socket.on("end", () => { endAt ??= performance.now() - started; });
  socket.on("close", () => { closedAt ??= performance.now() - started; });
  socket.on("error", (e) => { error ??= e.message; });
  const piece = Buffer.alloc(mode === "burst" ? 65536 : 1024, 0x61);
  while (written < totalBytes && closedAt === null && !socket.destroyed) {
    const ok = socket.write(piece); written += piece.length;
    if (mode === "trickle" && written > 40_000) await new Promise((r) => setTimeout(r, 20));
    else if (!ok) await Promise.race([once(socket, "drain"), once(socket, "close")]).catch(() => undefined);
  }
  const wroteFor = performance.now() - started;
  await Promise.race([once(socket, "close").catch(() => undefined), new Promise((r) => setTimeout(r, 8000))]);
  const result = { mode, attemptedBytes: totalBytes, writtenBytes: written, writeLoopMs: Math.round(wroteFor), serverEndMs: endAt && Math.round(endAt),
    closeMs: closedAt && Math.round(closedAt), clientError: error, responses: received.split("\n").filter(Boolean) };
  socket.destroy();
  return result;
}
const out: Record<string, unknown> = { label };
try {
  await client.waitForSessionMessageBrokerReady(state, child, 10000);
  out.memBefore = mem();
  out.burst = await flood("burst", 64 * 1024 * 1024);
  out.memAfterBurst = mem();
  out.trickle = await flood("trickle", 3 * 1024 * 1024);
  out.memAfterTrickle = mem();
  out.pingAfter = await client.requestSessionMessageOnce("ping", {}, state).then(() => "ok", (e: Error) => e.message);
  out.brokerAlive = child.exitCode === null && child.signalCode === null;
} catch (e) { out.probeError = String(e); }
finally {
  if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  await rm(state, { recursive: true, force: true, maxRetries: 10 });
}
appendFileSync(log!, JSON.stringify(out) + "\n"); console.log(JSON.stringify(out, null, 1));
