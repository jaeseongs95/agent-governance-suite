// E7: key order / whitespace normalization. (a) raw JSON-RPC prepare variants, (b) peer-wait queryRevision via the packaged Codex PreToolUse hook.
import { Mcp, envFor, hookAsync, brokerRaw, dump, sleep, ROOT } from "./lib.mjs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
const tag = ROOT.split("/").pop();
const base = `/tmp/exp/e7-${tag}`; rmSync(base, { recursive: true, force: true }); mkdirSync(base + "/home", { recursive: true });
const state = base + "/state", env = envFor(state, base + "/home");
const m = new Mcp(env); await m.init(); const v = [], log = [];
// (a) raw JSON-RPC texts that differ only by key order and whitespace
const raw = (id, text) => new Promise((res) => { m.pending.set(id, res); m.child.stdin.write(text + "\n"); });
const t1 = `{"jsonrpc":"2.0","id":9001,"method":"tools/call","params":{"name":"prepare_session_message","arguments":{"schemaVersion":"1.0.0","targetHost":"codex","targetSessionId":"norm-t","body":"같은 본문","_sessionBinding":{"host":"codex","sessionId":"norm-s"}}}}`;
const t2 = `{ "method" : "tools/call", "params" : { "arguments" : { "_sessionBinding" : { "sessionId" : "norm-s" , "host" : "codex" }, "body" : "같은 본문", "targetSessionId" : "norm-t", "targetHost" : "codex", "schemaVersion" : "1.0.0" }, "name" : "prepare_session_message" }, "id" : 9002, "jsonrpc" : "2.0" }`;
const r1 = JSON.parse((await raw(9001, t1)).result.content[0].text), r2 = JSON.parse((await raw(9002, t2)).result.content[0].text);
const S = { host: "codex", sessionId: "norm-s" };
const s1 = await m.call("send_session_message", { schemaVersion: "1.0.0", messageId: r1.data.messageId, _sessionBinding: S });
const s2 = await m.call("send_session_message", { messageId: r2.data.messageId, _sessionBinding: { sessionId: "norm-s", host: "codex" }, schemaVersion: "1.0.0" });
const rows = dump(state, "SELECT message_id, body FROM messages WHERE target_session_id = 'norm-t'");
log.push({ case: "prepare-key-order", id1: r1.data.messageId, id2: r2.data.messageId, sameId: r1.data.messageId === r2.data.messageId, send1: s1.data, send2: s2.data, storedRows: rows.length, identicalBodies: rows.every((r) => r.body === "같은 본문") });
// (b) peer-wait queryRevision normalization
const X = { host: "codex", sessionId: "pw-x" }, Y = { host: "codex", sessionId: "pw-y" }, Z = { host: "codex", sessionId: "pw-z" };
for (const from of [Y, Z]) { const p = await m.call("prepare_session_message", { schemaVersion: "1.0.0", targetHost: X.host, targetSessionId: X.sessionId, body: "peer", _sessionBinding: from }); await m.call("send_session_message", { schemaVersion: "1.0.0", messageId: p.data.messageId, _sessionBinding: from }); }
const I = "inst-" + randomBytes(6).toString("hex"), R = "relay-" + randomBytes(6).toString("hex");
const setup = [];
setup.push(await brokerRaw(state, "presence-start", { target: X, instanceId: I, transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }));
setup.push(await brokerRaw(state, "acquire-relay", { target: X, transport: "codex-queue", relayId: R, pid: process.pid, parentPid: process.pid, instanceId: I }));
const nonce = randomBytes(24).toString("base64url");
setup.push(await brokerRaw(state, "reserve-wake", { target: X, nonce }));
setup.push(await brokerRaw(state, "claim-wake", { target: X, nonces: [nonce], maxMessages: 1 }));
log.push({ case: "peer-wait-setup", setup: setup.map((s) => ({ ok: s.ok, keys: Object.keys(s.data ?? {}), dispatch: s.data?.dispatch, recognized: s.data?.recognized, acquired: s.data?.acquired })) });
const hook = (toolInput, rawOverride) => hookAsync(env, ROOT + "/mcp-server/dist/session-message-hook.mjs", rawOverride ?? { hook_event_name: "PreToolUse", session_id: X.sessionId, agent_id: "", tool_name: "mcp__codex_app__wait_threads", tool_input: toolInput });
const classify = (out) => { if (!out) return "none"; const h = JSON.parse(out).hookSpecificOutput ?? {}; if (h.permissionDecision === "deny") return "deny"; return /one immediate snapshot/.test(h.additionalContext ?? "") ? "snapshot" : /Async resume is unconfirmed/.test(h.additionalContext ?? "") ? "bounded" : "other:" + (h.additionalContext ?? "").slice(0, 60); };
const queries = [
  ["q1 base [Y(c1), Z]", { targets: [{ threadId: "pw-y", afterCursor: "c1" }, { threadId: "pw-z" }], timeoutMs: 0 }, "snapshot"],
  ["q2 same set reordered + object keys reordered + hostId local", { timeoutMs: 0, targets: [{ hostId: "local", threadId: "pw-z" }, { afterCursor: "c1", threadId: "pw-y" }] }, "deny"],
  ["q3 duplicate identical target", { targets: [{ threadId: "pw-y", afterCursor: "c1" }, { threadId: "pw-z" }, { afterCursor: "c1", threadId: "pw-y" }], timeoutMs: 0 }, "deny"],
  ["q4 cursor changed c2", { targets: [{ threadId: "pw-y", afterCursor: "c2" }, { threadId: "pw-z" }], timeoutMs: 0 }, "snapshot"],
  ["q5 c2 reordered", { targets: [{ threadId: "pw-z" }, { threadId: "pw-y", afterCursor: "c2" }], timeoutMs: 0 }, "deny"],
  ["q6 timeoutMs omitted (default 120000)", { targets: [{ threadId: "pw-z" }, { threadId: "pw-y", afterCursor: "c2" }] }, "deny"],
  ["q7 afterCursor empty string vs absent", { targets: [{ threadId: "pw-z", afterCursor: "" }, { threadId: "pw-y", afterCursor: "c2" }], timeoutMs: 0 }, "snapshot"],
  ["q8 afterCursor null", { targets: [{ threadId: "pw-z", afterCursor: null }, { threadId: "pw-y", afterCursor: "c2" }], timeoutMs: 0 }, "none"],
];
for (const [name, input, expect] of queries) {
  await brokerRaw(state, "heartbeat-relay", { target: X, transport: "codex-queue", relayId: R, instanceId: I });
  const out = await hook(input); const got = classify(out);
  log.push({ case: "peer-wait", name, expect, got }); if (got !== expect) v.push({ kind: "peer-wait-normalization", name, expect, got, out: out.slice(0, 400) });
}
// broker-level: queryRevision is compared as an opaque string (hosts must canonicalize before sending)
await brokerRaw(state, "heartbeat-relay", { target: X, transport: "codex-queue", relayId: R, instanceId: I });
const b1 = await brokerRaw(state, "peer-wait", { sender: X, targets: [Y], timeoutMs: 0, queryRevision: JSON.stringify({ a: 1, b: 2 }) });
const b2 = await brokerRaw(state, "peer-wait", { sender: X, targets: [Y], timeoutMs: 0, queryRevision: JSON.stringify({ b: 2, a: 1 }) });
const b3 = await brokerRaw(state, "peer-wait", { sender: X, targets: [Y, Y], timeoutMs: 0, queryRevision: JSON.stringify({ b: 2, a: 1 }) });
log.push({ case: "broker-opaque-queryRevision", keyOrderA: b1.data?.action, keyOrderB: b2.data?.action, duplicateTargetSameRev: b3.data?.action });
m.close();
const summary = { exp: "E7", root: ROOT, cases: log.length, violations: v.length };
writeFileSync(`/tmp/ev/e7-${tag}.json`, JSON.stringify({ summary, violations: v, log }, null, 1));
console.log(JSON.stringify(summary)); for (const l of log) console.log(JSON.stringify(l)); if (v.length) console.log(JSON.stringify(v));
