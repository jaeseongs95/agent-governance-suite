#!/usr/bin/env node
// Summarize capture output: per tools/call, key presence and hash-equality facts only.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2];
const rows = (f) => existsSync(path.join(dir, f)) ? readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const server = rows("server.jsonl");
const hooks = rows("hook.jsonl").filter((h) => h.event === "PreToolUse" || h.event === null);
for (const s of rows("status.jsonl")) console.log("status", s.case, s.phase, s.code ?? "", JSON.stringify(s.events ?? {}));
for (const s of server.filter((r) => r.kind === "start")) console.log("server-start", s.label, "envKeys", s.envKeys.join(","), "envSessionId", Boolean(s.envSessionId));
const envSession = Object.fromEntries(server.filter((r) => r.kind === "start" && r.envSessionId).map((r) => [r.label, r.envSessionId]));
for (const r of server.filter((x) => x.method === "tools/call")) {
  const ids = r.ids ?? {};
  const tm = "x-codex-turn-metadata";
  const callKey = ids.callId ? "callId" : ids["claudecode/toolUseId"] ? "claudecode/toolUseId" : null;
  const hook = callKey ? hooks.find((h) => h.ids?.tool_use_id && h.ids.tool_use_id === ids[callKey]) : null;
  console.log(JSON.stringify({
    label: r.label, probe: r.probeLabel ?? null, argKeys: r.argKeys, sess6: (ids.sessionId ?? "").slice(0, 6) || null, thread6: (ids.threadId ?? "").slice(0, 6) || null, metaKeys: r.metaKeys ?? r.metaType, turnMetaKeys: r.nested?.[tm] ?? null, turnMetaEncoding: r.nested?.[`${tm}:encoding`] ?? "object",
    sessionEqTurn: ids.sessionId && ids[`${tm}.session_id`] ? ids.sessionId === ids[`${tm}.session_id`] : null,
    threadEqTurn: ids.threadId && ids[`${tm}.thread_id`] ? ids.threadId === ids[`${tm}.thread_id`] : null,
    threadEqSession: ids.threadId && ids.sessionId ? ids.threadId === ids.sessionId : null,
    parentThread: Boolean(ids[`${tm}.parent_thread_id`]), subagentKind: ids[`${tm}.subagent_kind`] ?? null, threadSource: ids[`${tm}.thread_source`] ?? null,
    model: Boolean(ids[`${tm}.model`]), effort: Boolean(ids[`${tm}.reasoning_effort`]), turnId: Boolean(ids[`${tm}.turn_id`]),
    callKey, hookMatchedByCallId: Boolean(hook), hookSessionEqMetaSession: hook && ids.sessionId ? hook.ids.session_id === ids.sessionId : null,
    hookSessionEqEnvSession: hook && envSession[r.label] ? hook.ids.session_id === envSession[r.label] : null,
    hookAgentId: hook ? Boolean(hook.ids.agent_id) : null, hookAgentType: hook?.agentType ?? null,
    hookTurnEqMetaTurn: hook && ids[`${tm}.turn_id`] ? hook.ids.turn_id === ids[`${tm}.turn_id`] : null,
  }));
}
for (const h of hooks.filter((x) => x.ids?.conversationId || x.toolCallKeys?.length)) {
  console.log("agy-hook", JSON.stringify({ tool: h.tool, keys: h.keys, toolCallKeys: h.toolCallKeys, conv6: (h.ids.conversationId ?? "").slice(0, 6) || null, toolCallId: Boolean(h.ids["toolCall.id"]) }));
}
console.log("hooks", hooks.length, "toolCalls", server.filter((x) => x.method === "tools/call").length,
  "hookKeysUnion", [...new Set(hooks.flatMap((h) => h.keys))].sort().join(","));
