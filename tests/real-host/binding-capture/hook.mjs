#!/usr/bin/env node
// Record-only hook: key names and salted-hash equality tokens of the host hook input; never raw values.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const dir = process.env.CAPTURE_DIR || process.argv.find((a) => a.startsWith("--dir="))?.slice(6) || path.join(process.cwd(), "capture-out");
mkdirSync(dir, { recursive: true });
const saltFile = path.join(dir, "salt");
if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString("hex"));
const salt = readFileSync(saltFile, "utf8");
const h = (v) => typeof v === "string" && v ? createHash("sha256").update(salt + v).digest("hex").slice(0, 12) : null;
let raw = "";
try { raw = readFileSync(0, "utf8"); } catch { /* none */ }
let input = {};
try { input = JSON.parse(raw); } catch { /* keep empty */ }
const toolCall = input.toolCall && typeof input.toolCall === "object" ? input.toolCall : {};
const ids = {};
for (const k of ["session_id", "tool_use_id", "agent_id", "turn_id", "conversationId", "transcript_path", "transcriptPath", "model", "modelName"]) {
  if (typeof input[k] === "string") ids[k] = h(input[k]);
}
if (typeof toolCall.id === "string") ids["toolCall.id"] = h(toolCall.id);
appendFileSync(path.join(dir, "hook.jsonl"), JSON.stringify({ t: new Date().toISOString(), pid: process.pid,
  event: input.hook_event_name ?? input.hookEventName ?? process.argv.find((a) => a.startsWith("--event="))?.slice(8) ?? null,
  tool: input.tool_name ?? toolCall.name ?? null, keys: Object.keys(input).sort(), toolCallKeys: Object.keys(toolCall).sort(),
  agentType: typeof input.agent_type === "string" ? input.agent_type.slice(0, 40) : null, ids,
  envKeys: Object.keys(process.env).filter((k) => /^(CLAUDE|CODEX|ANTIGRAVITY|GEMINI|AGY)/i.test(k)).sort() }) + "\n");
if (process.argv.includes("--agy")) process.stdout.write(JSON.stringify({ decision: "allow" }));
process.exitCode = 0;
