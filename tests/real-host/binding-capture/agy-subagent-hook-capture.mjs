#!/usr/bin/env node
// AGS3-D-0068 capture: does an agy subagent's hook input carry anything that names its root conversation?
// Records key paths and salted-hash equality tokens only; never raw values or bodies. Three modes:
//   node agy-subagent-hook-capture.mjs run <outDir> [nested]   one agy -p run with every agy hook event registered
//   node agy-subagent-hook-capture.mjs hook --event=E --dir=D  the hook command agy runs
//   node agy-subagent-hook-capture.mjs sum <outDir>            key names, events and hash-equality facts
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode, ...rest] = process.argv.slice(2);
const EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "PreToolUse", "PostToolUse", "Stop"];
// Conversation IDs are UUID-like; a path or text may embed one, so ID-shaped tokens are hashed one by one too.
const TOKEN = /[A-Za-z0-9-]{16,}/gu;

function salted(dir) {
  const file = path.join(dir, "salt");
  if (!existsSync(file)) writeFileSync(file, randomBytes(16).toString("hex"));
  const salt = readFileSync(file, "utf8");
  return (value) => createHash("sha256").update(salt + value).digest("hex").slice(0, 16);
}

/** path -> { h: hash of the whole string, t: hashes of ID-shaped tokens } for strings; path -> type otherwise. */
function describe(value, h, prefix = "", out = {}, depth = 0) {
  if (typeof value === "string") out[prefix] = { h: h(value), t: [...new Set(value.match(TOKEN) ?? [])].map(h) };
  else if (value && typeof value === "object" && depth < 5) {
    const entries = Array.isArray(value) ? value.slice(0, 20).map((v, i) => [String(i), v]) : Object.entries(value);
    if (entries.length === 0) out[prefix] = Array.isArray(value) ? "array:0" : "object:0";
    for (const [k, v] of entries) describe(v, h, prefix ? `${prefix}.${k}` : k, out, depth + 1);
  } else out[prefix] = value === null ? "null" : typeof value;
  return out;
}

if (mode === "hook") {
  const arg = (name) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dir = arg("dir"), event = arg("event");
  mkdirSync(dir, { recursive: true });
  const h = salted(dir);
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* recorded as empty */ }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (/^(ANTIGRAVITY|AGY|GEMINI|PLUGIN|AGS|AGENT)/iu.test(k)) env[k] = describe(v, h)[""];
  appendFileSync(path.join(dir, "hook.jsonl"), JSON.stringify({ t: Date.now(), pid: process.pid, ppid: process.ppid, event,
    conv: typeof input.conversationId === "string" ? h(input.conversationId) : null,
    tool: typeof input.toolCall?.name === "string" ? input.toolCall.name.slice(0, 60) : null,
    keys: Object.keys(input).sort(), paths: describe(input, h), env }) + "\n");
  process.stdout.write(JSON.stringify(event === "PreToolUse" ? { decision: "allow" } : {}));
} else if (mode === "run") {
  const out = path.resolve(rest[0]);
  const work = path.join(out, "work");
  mkdirSync(path.join(work, ".agents"), { recursive: true });
  const self = fileURLToPath(import.meta.url);
  const command = (event) => `node ${self} hook --event=${event} --dir=${out}`;
  const hooks = { capture: Object.fromEntries(EVENTS.map((event) => [event, event.endsWith("ToolUse")
    ? [{ matcher: ".*", hooks: [{ type: "command", command: command(event), timeout: 10 }] }]
    : [{ type: "command", command: command(event), timeout: 10 }]])) };
  writeFileSync(path.join(work, ".agents", "hooks.json"), JSON.stringify(hooks, null, 2));
  const prompt = rest[1] === "nested"
    ? "Automated hook capture test; follow exactly. 1) Run the shell command `echo nest-0`. 2) Start exactly one subagent A and tell A: "
      + "run `echo nest-1`, then start exactly one subagent B of your own and tell B to run `echo nest-2` and reply DONE; wait for B, then reply DONE. "
      + "3) Wait for A to finish. 4) Run `echo nest-3`. 5) Reply DONE."
    : "Automated hook capture test; follow exactly. 1) Run the shell command `echo root-1`. 2) Start exactly one subagent and tell it to "
      + "run the shell command `echo sub-1` and then reply DONE; wait for it to finish. 3) Run `echo root-2`. 4) Reply DONE.";
  const child = spawn("agy", ["-p", prompt, "--output-format", "stream-json", "--dangerously-skip-permissions", "--print-timeout", "420s"],
    { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
  const events = {};
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      try { const type = JSON.parse(buf.slice(0, i)).type ?? "?"; events[type] = (events[type] ?? 0) + 1; } catch { /* not json */ }
    }
  });
  child.stderr.on("data", () => { events.stderrChunks = (events.stderrChunks ?? 0) + 1; });
  child.on("exit", (code, signal) => {
    appendFileSync(path.join(out, "status.jsonl"), JSON.stringify({ code, signal, events }) + "\n");
    process.exitCode = code ?? 1;
  });
} else if (mode === "sum") {
  const dir = path.resolve(rest[0]);
  const rows = readFileSync(path.join(dir, "hook.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  for (const s of existsSync(path.join(dir, "status.jsonl")) ? readFileSync(path.join(dir, "status.jsonl"), "utf8").split("\n").filter(Boolean) : []) console.log("status", s);
  const convs = [...new Set(rows.map((r) => r.conv).filter(Boolean))];
  const root = convs[0];
  const label = (c) => c === root ? "root" : c ? `sub${convs.indexOf(c)}` : "none";
  /** Paths (input or env) whose whole value or an ID-shaped token equals the hashed conversation `target`. */
  const refs = (r, target) => [
    ...Object.entries(r.paths).filter(([, d]) => d?.h === target || d?.t?.includes(target)).map(([p, d]) => `${p}${d.h === target ? "=" : "~"}`),
    ...Object.entries(r.env).filter(([, d]) => d?.h === target || d?.t?.includes(target)).map(([k, d]) => `env.${k}${d.h === target ? "=" : "~"}`),
  ];
  console.log("conversations", convs.length, "rows", rows.length);
  const groups = {};
  for (const r of rows) {
    const key = `${label(r.conv)} ${r.event}`;
    const g = groups[key] ??= { n: 0, keys: new Set(), tools: new Set(), ppids: new Set(), refs: {} };
    g.n += 1; r.keys.forEach((k) => g.keys.add(k)); if (r.tool) g.tools.add(r.tool); g.ppids.add(r.ppid);
    for (const c of convs) for (const p of refs(r, c)) (g.refs[label(c)] ??= new Set()).add(p);
  }
  for (const [key, g] of Object.entries(groups)) {
    console.log(JSON.stringify({ group: key, n: g.n, keys: [...g.keys].sort(), tools: [...g.tools], ppids: g.ppids.size,
      refs: Object.fromEntries(Object.entries(g.refs).map(([c, s]) => [c, [...s].sort()])) }));
  }
  const ppid = (c) => new Set(rows.filter((r) => r.conv === c).map((r) => r.ppid));
  for (const c of convs.slice(1)) console.log(label(c), "sharesHookParentProcessWithRoot", [...ppid(c)].some((p) => ppid(root).has(p)));
} else {
  console.error("usage: run <outDir> [nested] | hook --event=E --dir=D | sum <outDir>");
  process.exitCode = 2;
}
