// Audit probe: one message body within the 4096-byte body limit whose JSON-escaped claim answer passes 16384 bytes, claimed
// with the bundled hook's limits (maxMessages 1, maxBodyChars 4096). Checks the release-note claim that the hook path could
// not reach 16384 bytes. Usage: node --import tsx hook-shape-probe.mts <repo> <label> <log.jsonl>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import tls from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, label, log] = process.argv.slice(2);
const client = await import(pathToFileURL(path.join(repo!, "mcp-server/src/session-message-client.ts")).href);
const connect = tls.connect; let sizes: number[][] = [];
(tls as any).connect = function (...args: unknown[]) { const s = (connect as any).apply(this, args); const r: number[] = []; sizes.push(r); s.on("data", (c: Buffer) => r.push(c.length)); return s; };
const state = await mkdtemp(path.join(tmpdir(), "ags-audit-hookshape-"));
const child = spawn(process.execPath, ["--import", "tsx", path.join(repo!, "mcp-server/src/session-message-broker.ts"), "--state-directory", state], { windowsHide: true, stdio: "ignore" });
const out: Record<string, unknown> = { label, cases: [] };
try {
  await client.waitForSessionMessageBrokerReady(state, child, 10000);
  const sender = { host: "portable", sessionId: "sender" };
  for (let shift = 0; shift < 3; shift += 1) {
    const target = { host: "portable", sessionId: `hook-shape-${shift}` };
    const body = `${"a".repeat(shift)}${"\u0001".repeat(2600)}${"한".repeat(496)}`;
    const { messageId } = await client.requestSessionMessageOnce("prepare", { sender, target, body }, state);
    await client.requestSessionMessageOnce("send", { sender, messageId }, state);
    sizes = [];
    const result = await client.requestSessionMessageOnce("claim", { target, maxMessages: 1, maxBodyChars: 4096 }, state)
      .then((d: any) => ({ returned: d.messages.length, intact: d.messages[0]?.body === body, replacement: (d.messages[0]?.body ?? "").split("�").length - 1 }),
        (e: Error) => ({ error: `${e.constructor.name}: ${e.message}` }));
    (out.cases as unknown[]).push({ shift, bodyBytes: Buffer.byteLength(body), responseChunks: sizes[0], ...result });
  }
} catch (e) { out.probeError = String(e); }
finally {
  if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  await rm(state, { recursive: true, force: true, maxRetries: 10 });
}
appendFileSync(log!, JSON.stringify(out) + "\n"); console.log(JSON.stringify(out));
