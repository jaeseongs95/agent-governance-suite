// Shared harness: MCP stdio client, CLI and hook runners. No product code is modified.
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
export const ROOT = process.env.TARGET_ROOT ?? "/tmp/v53";
export function envFor(state, home) {
  const e = { PATH: process.env.PATH, HOME: home, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state,
    AGENT_GOVERNANCE_SHARED_STATE_DIR: home + "/.ags", AGENT_GOVERNANCE_TRUST_DB_PATH: state + "/trust.sqlite3" };
  return e;
}
export class Mcp {
  constructor(env, root = ROOT) {
    this.child = spawn(process.execPath, [root + "/mcp-server/dist/server.mjs"], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.pending = new Map(); this.id = 0; this.stderr = "";
    this.child.stderr.on("data", (d) => { this.stderr += d; });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let m; try { m = JSON.parse(line); } catch { return; }
      const p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); p(m); }
    });
  }
  rpc(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => { this.pending.set(id, resolve); this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
  }
  async init() {
    const r = await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "exp", version: "0" } });
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return r;
  }
  async call(name, args) {
    const r = await this.rpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text;
    let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = { raw: text, rpc: r }; }
    return parsed;
  }
  close() { try { this.child.stdin.end(); this.child.kill(); } catch {} }
}
export function cli(env, operation, payload, root = ROOT) {
  const r = spawnSync(process.execPath, [root + "/mcp-server/dist/session-message-cli.mjs"], { env, input: JSON.stringify({ operation, payload }), encoding: "utf8" });
  try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: r.stdout, stderr: r.stderr, status: r.status }; }
}
export function cliAsync(env, operation, payload, root = ROOT) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [root + "/mcp-server/dist/session-message-cli.mjs"], { env });
    let out = ""; c.stdout.on("data", (d) => out += d); c.on("close", () => { try { resolve(JSON.parse(out)); } catch { resolve({ ok: false, raw: out }); } });
    c.stdin.end(JSON.stringify({ operation, payload }));
  });
}
export function hookAsync(env, script, input, args = []) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [script, ...args], { env });
    let out = ""; c.stdout.on("data", (d) => out += d); c.on("close", () => resolve(out));
    c.stdin.end(JSON.stringify(input));
  });
}
// mulberry32 seeded PRNG
export function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
import tls from "node:tls";
import { readFileSync as rfs } from "node:fs";
import { DatabaseSync } from "node:sqlite";
// Raw broker request over the published TLS endpoint (same protocol as the packaged client).
export function brokerRaw(state, operation, payload) {
  const endpoint = JSON.parse(rfs(state + "/endpoint.json", "utf8"));
  const token = rfs(state + "/broker.token", "utf8").trim();
  const ca = rfs(state + "/broker-cert.pem", "utf8");
  return new Promise((resolve, reject) => {
    let buf = "";
    const s = tls.connect({ host: "127.0.0.1", port: endpoint.port, ca, servername: "localhost", minVersion: "TLSv1.3",
      checkServerIdentity: (_h, c) => c.fingerprint256 === endpoint.certificateFingerprint256 ? undefined : new Error("pin") });
    s.once("secureConnect", () => s.write(JSON.stringify({ protocolVersion: "1.0.0", token, operation, payload }) + "\n"));
    s.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { s.destroy(); resolve(JSON.parse(buf.slice(0, i))); } });
    s.once("error", reject);
  });
}
export function dump(state, sql = "SELECT * FROM messages ORDER BY created_at, message_id", params = []) {
  const db = new DatabaseSync(state + "/session-messages.sqlite3", { readOnly: true });
  db.exec("PRAGMA busy_timeout = 10000");
  try { return db.prepare(sql).all(...params); } finally { db.close(); }
}
export function stopBroker(state) {
  try { const e = JSON.parse(rfs(state + "/endpoint.json", "utf8")); process.kill(e.pid, "SIGTERM"); return e.pid; } catch { return null; }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
