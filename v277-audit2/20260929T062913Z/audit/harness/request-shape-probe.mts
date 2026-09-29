// Audit probe for the corrected compatibility sentence: the 2.7.7 client (<repo>) sends a prepare whose body is within
// 4096 bytes but control-character heavy, so the request line passes 16384 bytes with a Korean character across the
// TLS chunk. The body is then claimed back and compared. Broker: <broker> (a dist .mjs, or "source" for <repo>'s source).
// Usage: node --import tsx request-shape-probe.mts <repo> <broker> <label> <log.jsonl>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, broker, label, log] = process.argv.slice(2);
const client = await import(pathToFileURL(path.join(repo!, "mcp-server/src/session-message-client.ts")).href);
const protocol = await import(pathToFileURL(path.join(repo!, "mcp-server/src/session-message-protocol.ts")).href);
const state = await mkdtemp(path.join(tmpdir(), "ags-audit-reqshape-"));
const args = broker === "source" ? ["--import", "tsx", path.join(repo!, "mcp-server/src/session-message-broker.ts")] : [broker!];
const child = spawn(process.execPath, [...args, "--state-directory", state], { windowsHide: true, stdio: "ignore",
  env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state, AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"), AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared") } });
const out: Record<string, unknown> = { label, broker: broker === "source" ? "source" : path.basename(path.dirname(broker!)), cases: [] };
const headBytes = (bytes: Buffer, at: number) => { let s = at - 1; while ((bytes[s]! & 0xc0) === 0x80) s -= 1;
  const len = bytes[s]! >= 0xf0 ? 4 : bytes[s]! >= 0xe0 ? 3 : bytes[s]! >= 0xc0 ? 2 : 1; return s + len > at ? at - s : 0; };
try {
  await client.waitForSessionMessageBrokerReady(state, child, 10000);
  const token = (await readFile(path.join(state, "broker.token"), "utf8")).trim();
  const sender = { host: "portable", sessionId: "sender" };
  for (let shift = 0; shift < 3; shift += 1) {
    const target = { host: "portable", sessionId: `req-shape-${shift}` };
    const body = `${"a".repeat(shift)}${"\u0001".repeat(2600)}${"한".repeat(496)}`;
    const line = Buffer.from(`${JSON.stringify({ protocolVersion: protocol.SESSION_MESSAGE_PROTOCOL, token, operation: "prepare", payload: { sender, target, body } })}\n`);
    const result: Record<string, unknown> = { shift, bodyBytes: Buffer.byteLength(body), requestLineBytes: line.length, headAt16384: headBytes(line, 16384) };
    try {
      const { messageId } = await client.requestSessionMessageOnce("prepare", { sender, target, body }, state);
      await client.requestSessionMessageOnce("send", { sender, messageId }, state);
      const claimed = await client.requestSessionMessageOnce("claim", { target, maxMessages: 1, maxBodyChars: 4096 }, state);
      const got = claimed.messages[0]?.body ?? "";
      Object.assign(result, { stored: true, intact: got === body, replacement: got.split("�").length - 1 });
    } catch (error) { result.error = `${(error as Error).constructor.name}: ${(error as Error).message}`; }
    (out.cases as unknown[]).push(result);
  }
} catch (e) { out.probeError = String(e); }
finally {
  if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  await rm(state, { recursive: true, force: true, maxRetries: 10 });
}
appendFileSync(log!, JSON.stringify(out) + "\n"); console.log(JSON.stringify(out));
