// Audit probe: lease case and TLS chunk sizes against a real broker started from <repo>'s source.
// Usage: node --import tsx lease-probe.mts <repo> <label> <log.jsonl>
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import tls from "node:tls";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, label, log] = process.argv.slice(2);
const imp = (p: string) => import(pathToFileURL(path.join(repo!, p)).href);
const { runSessionMessageCli } = await imp("mcp-server/src/session-message-cli.ts");
const client = await imp("mcp-server/src/session-message-client.ts");
const protocol = await imp("mcp-server/src/session-message-protocol.ts");
const { SessionMessageStore } = await imp("mcp-server/src/session-message-store.ts");
// Layout helpers are the candidate's test fixture (not product code); the probe checks their claims on the wire.
const layout = await import(pathToFileURL(path.join(process.env.AGS_LAYOUT_REPO!, "tests/session-messaging/fixtures/utf8-layout.ts")).href);
const chunkLog = path.join(path.dirname(log!), `chunks-${label}.jsonl`);
const connect = tls.connect;
let connections: Array<{ sizes: number[]; total: number }> = [];
(tls as any).connect = function (...args: unknown[]) {
  const socket = (connect as any).apply(this, args);
  const record = { sizes: [] as number[], total: 0 }; connections.push(record);
  socket.on("data", (chunk: Buffer) => { record.sizes.push(chunk.length); record.total += chunk.length; });
  return socket;
};
const state = await mkdtemp(path.join(tmpdir(), "ags-audit-lease-"));
const child = spawn(process.execPath, ["--import", "tsx", "--import", pathToFileURL(path.join(import.meta.dirname, "chunk-preload.mjs")).href,
  path.join(repo!, "mcp-server/src/session-message-broker.ts"), "--state-directory", state],
  { windowsHide: true, stdio: "ignore", env: { ...process.env, AGS_AUDIT_CHUNKS: chunkLog } });
const out: Record<string, unknown> = { label };
try {
  await client.waitForSessionMessageBrokerReady(state, child, 10000);
  const sender = { host: "portable", sessionId: "sender" }, target = { host: "portable", sessionId: "recipient" };
  const queue = (bodies: string[]) => { const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
    try { const base = Date.now(); bodies.forEach((body, i) => store.submitPrepared(sender, store.prepare({ sender, target, body }, base + i).messageId, base + i)); } finally { store.close(); } };
  // Case 1: a 32767-byte Korean claim answer with a character split 1|2 at byte 16384, through the CLI claim path.
  const bodies = layout.straddlingClaim(sender, target, protocol.SESSION_MESSAGE_MAX_RESPONSE_BYTES - 1, 1);
  queue(bodies);
  connections = [];
  const cli = await runSessionMessageCli(JSON.stringify({ operation: "claim", payload: { target } }), state);
  const cliConnections = connections.map((c) => ({ ...c }));
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
  let rows: Array<Record<string, unknown>>;
  try { rows = store.database.prepare("SELECT delivery_attempts, claimed_at, claim_until FROM messages WHERE acknowledged_at IS NULL").all() as Array<Record<string, unknown>>; } finally { store.close(); }
  connections = [];
  const again = await client.requestSessionMessageOnce("claim", { target }, state).then((d: any) => d.messages.length, (e: Error) => `error: ${e.message}`);
  out.lease = { cliOk: cli.ok, cliError: cli.ok ? null : cli.error ?? null, cliReturned: cli.data?.messages?.length ?? null,
    intact: cli.data?.messages ? cli.data.messages.map((m: any) => m.body).join("\n") === bodies.join("\n") : false,
    replacementChars: JSON.stringify(cli.data ?? {}).split("�").length - 1,
    brokerConnectionsDuringCli: cliConnections.length, responseChunkSizes: cliConnections.map((c) => c.sizes), responseBytes: cliConnections.map((c) => c.total),
    unackedRows: rows.length, attempts: [...new Set(rows.map((r) => r.delivery_attempts))],
    leaseMs: [...new Set(rows.map((r) => Date.parse(String(r.claim_until)) - Date.parse(String(r.claimed_at))))], immediateReclaim: again };
  // Case 2: a request line of exactly the request limit with a Korean character split 1|2 at byte 16384.
  const token = (await readFile(path.join(state, "broker.token"), "utf8")).trim();
  const ping = layout.straddlingPing(token, protocol.SESSION_MESSAGE_MAX_REQUEST_BYTES, 1);
  out.requestAtLimit = await client.requestSessionMessageOnce("ping", ping, state).then(() => "accepted", (e: Error) => `${e.constructor.name}: ${e.message}`);
} catch (error) { out.probeError = String(error); }
finally {
  if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  await rm(state, { recursive: true, force: true, maxRetries: 10 });
}
out.brokerRequestChunks = (await readFile(chunkLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).reduce((acc: Record<string, number[]>, r: any) => { (acc[r.socket] ??= []).push(r.size); return acc; }, {});
out.brokerRequestChunks = Object.values(out.brokerRequestChunks as Record<string, number[]>);
appendFileSync(log!, JSON.stringify(out) + "\n");
console.log(JSON.stringify(out, null, 1));
