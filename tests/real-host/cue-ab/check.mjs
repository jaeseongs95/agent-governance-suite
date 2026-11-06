// Judges one finished conversation without knowing its arm: node check.mjs <claude|codex> <runDir> [skillsFile] -> JSON on stdout.
// runDir holds turns.jsonl (one line per planned turn: turn, exit, seconds, skipped) and the raw log turn-<n>.jsonl of each turn.
// A skill counts as called only when the transcript shows the host actually loading it: Claude's Skill tool_use, or a
// Codex command that reads the skill's SKILL.md. A skill name in answer text is never a call.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TURNS } from "./tasks.mjs";

const PLUGIN_PREFIX = "agent-governance-suite:";
// Verbs that put the file's text in front of the model. A listing or an existence test (ls, find, test -f) is not a read.
const READ_VERB = /(^|[\s;&|(`'"])(cat|sed|head|tail|nl|less|more|bat|awk|perl|python3?|node|type|Get-Content|gc|cut|strings|od|xxd|tee)(?=[\s;&|)`'"]|$)/u;
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function readJsonl(file) {
  if (!existsSync(file)) return { events: [], bad: 0, missing: true };
  const events = [];
  let bad = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { bad += 1; }
  }
  return { events, bad, missing: false };
}

const bump = (census, key) => { census[key] = (census[key] ?? 0) + 1; };

/** Context text a hook returned: hookSpecificOutput.additionalContext (or a top-level one), else 0. */
function contextChars(stdout) {
  if (typeof stdout !== "string" || stdout.trim() === "") return 0;
  try {
    const out = JSON.parse(stdout);
    const text = out?.hookSpecificOutput?.additionalContext ?? out?.additionalContext ?? out?.systemMessage;
    return typeof text === "string" ? text.length : 0;
  } catch {
    return 0;
  }
}

/** UserPromptSubmit hook output of one Claude turn, when the stream carries hook events; null when it carries none. */
function claudeHookCue(events) {
  const hooks = events
    .filter((event) => event.type === "system" && event.subtype === "hook_response" && (event.hook_event ?? event.hook_event_name) === "UserPromptSubmit")
    .map((event) => {
      const stdout = String(event.stdout ?? event.output ?? "");
      return { name: event.hook_name ?? null, stdoutChars: stdout.length, contextChars: contextChars(stdout) };
    });
  if (hooks.length === 0) return null;
  return { source: "stream-json", hooks, stdoutChars: hooks.reduce((n, h) => n + h.stdoutChars, 0), contextChars: hooks.reduce((n, h) => n + h.contextChars, 0) };
}

function claudeTurn(events, state) {
  const result = { calls: [], weak: [], completed: false, failed: false, sessionId: null, census: {}, hookCue: claudeHookCue(events), mcpTools: [] };
  for (const event of events) {
    bump(result.census, `${event.type}${event.subtype ? `/${event.subtype}` : ""}${event.hook_event ? `:${event.hook_event}` : ""}`);
    if (typeof event.session_id === "string") result.sessionId = event.session_id;
    if (event.type === "system" && event.subtype === "init" && typeof event.model === "string") result.model = event.model;
    if (event.type === "result") {
      result.completed = true;
      result.failed = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
      result.resultSubtype = event.subtype ?? null;
    }
    if (event.type !== "assistant" || !Array.isArray(event.message?.content)) continue;
    for (const block of event.message.content) {
      if (block?.type !== "tool_use") continue;
      if (typeof block.name === "string" && block.name.startsWith("mcp__")) result.mcpTools.push(block.name.split("__").at(-1));
      if (block.name !== "Skill" || typeof block.input?.skill !== "string") continue;
      // `--resume` could replay earlier messages; a tool_use id seen in an earlier turn is not this turn's call.
      if (block.id && state.seenToolUse.has(block.id)) continue;
      if (block.id) state.seenToolUse.add(block.id);
      result.calls.push({ raw: block.input.skill, name: block.input.skill.split(":").at(-1), plugin: block.input.skill.startsWith(PLUGIN_PREFIX), sub: event.parent_tool_use_id != null });
    }
  }
  return result;
}

function codexTurn(events, known) {
  const result = { calls: [], weak: [], completed: false, failed: false, sessionId: null, census: {}, hookCue: null, mcpTools: [] };
  const strict = new Set();
  const weak = new Set();
  for (const event of events) {
    bump(result.census, event.item ? `${event.type}:${event.item.type}` : event.type);
    if (event.type === "thread.started" && typeof event.thread_id === "string") result.sessionId = event.thread_id;
    if (event.type === "turn.completed") result.completed = true;
    if (event.type === "turn.failed") result.failed = true;
    if (event.type !== "item.completed" || !event.item) continue;
    const { item } = event;
    if (item.type === "mcp_tool_call" && typeof item.tool === "string") result.mcpTools.push(item.tool);
    // Only a finished, successful command is a read. Its text is the command line, never the model's answer.
    if (item.type !== "command_execution" || typeof item.command !== "string") continue;
    const reads = item.exit_code === 0 && READ_VERB.test(item.command);
    for (const name of known) {
      if (!new RegExp(`/${escapeRegExp(name)}/SKILL\\.md`, "u").test(item.command)) continue;
      (reads ? strict : weak).add(name);
    }
  }
  result.calls = [...strict].map((name) => ({ raw: name, name, plugin: true, sub: false }));
  result.weak = [...weak].filter((name) => !strict.has(name));
  return result;
}

/** Judges all planned turns of one run. `known` is the set of AGS skill names (union of both arms' skills/ folders). */
export function judgeRun(host, runDir, known) {
  const state = { seenToolUse: new Set() };
  const planned = readJsonl(path.join(runDir, "turns.jsonl")).events;
  const turns = TURNS.map((spec, index) => {
    const n = index + 1;
    const meta = planned.find((row) => row.turn === n) ?? { turn: n, missing: true };
    const log = readJsonl(path.join(runDir, `turn-${n}.jsonl`));
    const parsed = host === "claude" ? claudeTurn(log.events, state) : codexTurn(log.events, known);
    let status = "ok";
    let reason = null;
    if (meta.skipped) [status, reason] = ["skipped", meta.reason ?? "earlier turn gave no session id"];
    else if (meta.missing) [status, reason] = ["skipped", "turn never started"];
    else if (meta.exit === 124) [status, reason] = ["timeout", "exit 124"];
    else if (meta.exit !== 0) [status, reason] = ["error", `exit ${meta.exit}`];
    else if (log.events.length === 0) [status, reason] = ["error", "empty log"];
    else if (!parsed.completed) [status, reason] = ["error", "no completion event"];
    else if (parsed.failed) [status, reason] = ["error", parsed.resultSubtype ?? "turn failed"];
    const isAgs = (call) => call.plugin || known.has(call.name);
    const agsCalls = parsed.calls.filter(isAgs);
    const foreign = [...new Set(parsed.calls.filter((call) => !isAgs(call)).map((call) => call.raw))];
    const names = [...new Set(agsCalls.map((call) => call.name))];
    const hit = status === "ok" && spec.expected.some((name) => names.includes(name));
    const overCalls = names.filter((name) => !spec.expected.includes(name) && !spec.tolerated.includes(name));
    const strictExtra = names.filter((name) => !spec.expected.includes(name));
    let verdict = status;
    if (status === "ok" && spec.kind === "control") verdict = names.length === 0 ? "ok" : "over";
    else if (status === "ok") verdict = (hit ? "hit" : "miss") + (overCalls.length > 0 ? "+over" : "");
    return {
      turn: n, id: spec.id, kind: spec.kind, expected: spec.expected, status, reason, seconds: meta.seconds ?? null,
      calls: names, foreign, weak: parsed.weak, hit, overCalls, strictExtra, verdict,
      subagentCalls: agsCalls.filter((call) => call.sub).map((call) => call.name),
      sessionId: parsed.sessionId, model: parsed.model ?? null, hookCue: parsed.hookCue, mcpTools: parsed.mcpTools, census: parsed.census, badLines: log.bad,
    };
  });
  const specialist = turns.filter((turn) => turn.kind === "specialist");
  const control = turns.filter((turn) => turn.kind === "control");
  const ok = turns.filter((turn) => turn.status === "ok");
  return {
    host, turns,
    totals: {
      specialistTurns: specialist.length, hits: specialist.filter((turn) => turn.hit).length,
      controlTurns: control.length, controlClean: control.filter((turn) => turn.verdict === "ok").length,
      overCallTurns: ok.filter((turn) => turn.overCalls.length > 0).length,
      overCallNames: ok.reduce((n, turn) => n + turn.overCalls.length, 0),
      strictExtraNames: ok.reduce((n, turn) => n + turn.strictExtra.length, 0),
      failedTurns: turns.length - ok.length,
    },
  };
}

export function readKnownSkills(file) {
  return new Set(file && existsSync(file) ? readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter(Boolean) : []);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [host, runDir, skillsFile] = process.argv.slice(2);
  if (!["claude", "codex"].includes(host) || !runDir) throw new Error("usage: node check.mjs <claude|codex> <runDir> [skillsFile]");
  process.stdout.write(JSON.stringify(judgeRun(host, runDir, readKnownSkills(skillsFile))));
}
