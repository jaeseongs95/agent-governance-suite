#!/usr/bin/env node
// Record-only stdio MCP server for host metadata capture. Logs key names, salted-hash equality tokens
// and a few closed enum values; never raw identifiers, arguments or bodies.
import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";

const dir = process.env.CAPTURE_DIR || path.join(process.cwd(), "capture-out");
mkdirSync(dir, { recursive: true });
const saltFile = path.join(dir, "salt");
if (!existsSync(saltFile)) writeFileSync(saltFile, randomBytes(16).toString("hex"));
const salt = readFileSync(saltFile, "utf8");
const h = (v) => typeof v === "string" && v ? createHash("sha256").update(salt + v).digest("hex").slice(0, 12) : null;
const log = (row) => appendFileSync(path.join(dir, "server.jsonl"), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, label: process.env.CAPTURE_LABEL ?? null, ...row }) + "\n");
const ENUMS = new Set(["subagent_kind", "thread_source", "request_kind", "turn_trigger"]);
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

log({ kind: "start", envKeys: Object.keys(process.env).filter((k) => /^(CLAUDE|CODEX|ANTIGRAVITY|GEMINI|AGY)/i.test(k)).sort(),
  envSessionId: h(process.env.CLAUDE_CODE_SESSION_ID), argv: process.argv.length });

function describeMeta(meta) {
  if (!isObj(meta)) return { metaType: meta === undefined ? "absent" : typeof meta };
  const out = { metaKeys: Object.keys(meta).sort(), ids: {}, nested: {}, enums: {} };
  for (const [k, v] of Object.entries(meta)) {
    if (typeof v === "string") out.ids[k] = h(v);
    let obj = v;
    if (typeof v === "string" && v.startsWith("{")) { try { obj = JSON.parse(v); out.nested[k + ":encoding"] = "json-string"; } catch { /* plain */ } }
    if (isObj(obj)) {
      out.nested[k] = Object.keys(obj).sort();
      for (const [nk, nv] of Object.entries(obj)) {
        if (typeof nv === "string") {
          out.ids[`${k}.${nk}`] = ENUMS.has(nk) ? `enum:${nv.slice(0, 40)}` : h(nv);
        } else if (isObj(nv)) out.nested[`${k}.${nk}`] = Object.keys(nv).sort();
        else out.ids[`${k}.${nk}`] = `type:${typeof nv}`;
      }
    }
  }
  return out;
}

let buffer = "";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log({ kind: "bad-json" }); continue; }
    const params = isObj(msg.params) ? msg.params : {};
    log({ kind: "rpc", method: msg.method ?? null, hasId: msg.id !== undefined, paramKeys: Object.keys(params).sort(),
      argKeys: isObj(params.arguments) ? Object.keys(params.arguments).sort() : null,
      tool: typeof params.name === "string" ? params.name : null,
      probeLabel: isObj(params.arguments) && /^[a-z0-9-]{1,20}$/.test(String(params.arguments.label)) ? params.arguments.label : null, ...describeMeta(params._meta) });
    if (msg.id === undefined) continue;
    if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: params.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} }, serverInfo: { name: "capture", version: "0.0.1" } } });
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "probe", description: "Capture probe. Call it when asked; it returns ok.",
        inputSchema: { type: "object", properties: { label: { type: "string" } }, additionalProperties: false } }] } });
    } else if (msg.method === "tools/call") {
      send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok" }] } });
    } else if (msg.method === "ping") {
      send({ jsonrpc: "2.0", id: msg.id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
    }
  }
});
