/** Explicit local native adapter CLI; no arbitrary program execution, model API calls, or task import. */
import { readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openNativePeerSession } from "./model-routing-peer-native.js";
import type { NativeRoutingHost } from "./model-routing-host-hook.js";
import { peerCheck, peerExact, peerObject } from "./model-peer-packet.js";
import type { SessionMessage } from "./session-message-store.js";

export async function runModelPeerCli(host: NativeRoutingHost, raw: string): Promise<unknown> {
  peerCheck(Buffer.byteLength(raw, "utf8") <= 16384, "Peer CLI input is too large.");
  const request = peerObject(JSON.parse(raw)); peerExact(request, ["operation", "nativeContext", "payload"]);
  const context = peerObject(request.nativeContext), payload = peerObject(request.payload);
  peerCheck(Object.keys(context).every(key => ["session_id", "instance_id"].includes(key)), "Unsupported native context field.");
  peerCheck(["send", "receive", "status", "preflight"].includes(String(request.operation)), "Unsupported peer handoff operation.");
  const opened = await openNativePeerSession(host, context);
  try {
    if (request.operation === "send") {
      peerExact(payload, ["decisionDigest", "delta", "inputReferences"]);
      peerCheck(typeof payload.decisionDigest === "string" && typeof payload.delta === "string" && Array.isArray(payload.inputReferences), "Invalid send arguments.");
      return await opened.session.send(payload.decisionDigest, { delta: payload.delta, inputReferences: payload.inputReferences });
    }
    if (request.operation === "status" || request.operation === "preflight") {
      peerExact(payload, ["packetId"]); peerCheck(typeof payload.packetId === "string", "Invalid packet ID.");
      return request.operation === "preflight" ? await opened.session.preflight(payload.packetId) : await opened.session.status(payload.packetId);
    }
    peerExact(payload, ["message"]);
    return await opened.session.receive(payload.message as SessionMessage);
  } finally { opened.close(); }
}
function stdin(): string {
  const parts: Buffer[] = []; let total = 0;
  for (;;) {
    const bytes = Buffer.alloc(4096), length = readSync(0, bytes, 0, bytes.length, null);
    if (!length) break;
    total += length; peerCheck(total <= 16384, "Peer CLI input is too large."); parts.push(bytes.subarray(0, length));
  }
  return Buffer.concat(parts).toString("utf8");
}
async function main(): Promise<void> {
  try {
    const [flag, host, ...rest] = process.argv.slice(2);
    peerCheck(flag === "--host" && (host === "codex" || host === "claude-code") && rest.length === 0, "Expected --host codex|claude-code.");
    const data = await runModelPeerCli(host, stdin());
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
  } catch {
    // No input/body/path/token or raw exception is copied to the caller-visible error.
    process.stdout.write(`${JSON.stringify({ ok: false, error: "PEER_HANDOFF_UNAVAILABLE", executionStarted: false })}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  && /\/model-routing-peer-cli\.(?:ts|mjs)$/u.test(import.meta.url)) await main();
