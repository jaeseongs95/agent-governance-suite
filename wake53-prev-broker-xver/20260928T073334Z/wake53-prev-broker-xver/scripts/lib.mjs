// Mixed-version experiment helpers. Uses only public entry points of each version:
// dist/session-message-broker.mjs, dist/session-message-cli.mjs, dist/session-message-hook.mjs,
// and the broker TLS line protocol (same framing the shipped client uses).
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { DatabaseSync } from "node:sqlite";

export const VERSIONS = {
  "53": "/tmp/v53", "2.7.1": "/tmp/prev-v2.7.1", "2.7.0": "/tmp/prev-v2.7.0", "2.6.0": "/tmp/prev-v2.6.0", "2.2.6": "/tmp/prev-v2.2.6",
};
const dist = (v, f) => path.join(VERSIONS[v], "mcp-server/dist", f);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mulberry32 seeded PRNG
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function envFor(dir) {
  const home = path.join(dir, "home"); mkdirSync(home, { recursive: true });
  return {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: process.env.TMPDIR ?? "/tmp",
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: dir,
    AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(dir, "trust.sqlite3"),
    AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(dir, "shared"),
    AGENT_GOVERNANCE_DB_PATH: path.join(dir, "gov.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(dir, "continuity.sqlite3"),
    AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(dir, "board.sqlite3"),
    AGENT_GOVERNANCE_CODEX_QUEUE_WAKE: "1",
  };
}

export class Log {
  constructor(file) { this.file = file; writeFileSync(file, ""); }
  w(...a) { const line = a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "); appendFileSync(this.file, line + "\n"); console.log(line); }
}

export async function startBroker(v, dir, log) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [dist(v, "session-message-broker.mjs"), "--state-directory", dir],
    { env: envFor(dir), stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const ep = JSON.parse(readFileSync(path.join(dir, "endpoint.json"), "utf8"));
      if (ep.pid === child.pid) { const p = await rpc(dir, "ping", {}); log?.w(`[broker ${v}] started pid=${child.pid} caps=${JSON.stringify(p.data?.capabilities)}`); return { v, child, exited, stderr: () => stderr }; }
    } catch { /* not ready */ }
    await sleep(50);
  }
  const ex = await Promise.race([exited, sleep(500).then(() => null)]);
  log?.w(`[broker ${v}] not serving: exit=${JSON.stringify(ex)} stderr=${stderr.trim()}`);
  return { v, child, exited, stderr: () => stderr, notServing: true, exit: ex };
}

export async function stopBroker(b, log) {
  if (!b || b.child.exitCode !== null || b.child.signalCode !== null) return;
  b.child.kill("SIGTERM"); const r = await b.exited; log?.w(`[broker ${b.v}] stopped pid=${b.child.pid} ${JSON.stringify(r)}`);
}

export function rpc(dir, operation, payload, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let endpoint, token, ca;
    try {
      endpoint = JSON.parse(readFileSync(path.join(dir, "endpoint.json"), "utf8"));
      token = readFileSync(path.join(dir, "broker.token"), "utf8").trim();
      ca = readFileSync(path.join(dir, "broker-cert.pem"), "utf8");
    } catch (e) { return resolve({ ok: false, error: `endpoint-unreadable:${e.code ?? e.message}` }); }
    let buf = ""; let done = false;
    const fin = (v) => { if (done) return; done = true; clearTimeout(t); sock.destroy(); resolve(v); };
    const sock = tls.connect({ host: "127.0.0.1", port: endpoint.port, ca, servername: "localhost", minVersion: "TLSv1.3",
      checkServerIdentity: (_h, c) => c.fingerprint256 === endpoint.certificateFingerprint256 ? undefined : new Error("pin") });
    const t = setTimeout(() => fin({ ok: false, error: "timeout" }), timeoutMs);
    sock.once("secureConnect", () => sock.write(JSON.stringify({ protocolVersion: endpoint.protocolVersion, token, operation, payload }) + "\n"));
    sock.on("data", (c) => { buf += c; const i = buf.indexOf("\n"); if (i >= 0) { try { fin(JSON.parse(buf.slice(0, i))); } catch { fin({ ok: false, error: "bad-json" }); } } });
    sock.once("error", (e) => fin({ ok: false, error: `socket:${e.code ?? e.message}` }));
  });
}

export function cli(v, dir, operation, payload) {
  const r = spawnSync(process.execPath, [dist(v, "session-message-cli.mjs")], { input: JSON.stringify({ operation, payload }),
    env: envFor(dir), encoding: "utf8", timeout: 30000 });
  let out; try { out = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { out = { raw: r.stdout, stderr: r.stderr }; }
  return { status: r.status, ...out };
}

export function hook(v, dir, input, extraArgs = []) {
  const r = spawnSync(process.execPath, [dist(v, "session-message-hook.mjs"), ...extraArgs], { input: JSON.stringify(input),
    env: envFor(dir), encoding: "utf8", timeout: 30000 });
  let out = {}; if (r.stdout.trim()) { try { out = JSON.parse(r.stdout); } catch { out = { raw: r.stdout }; } }
  return { status: r.status, out, stderr: r.stderr.trim() };
}

export function dump(dir, file) {
  const dbPath = path.join(dir, "session-messages.sqlite3");
  if (!existsSync(dbPath)) { writeFileSync(file, JSON.stringify({ missing: true }, null, 1)); return { missing: true }; }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
    const out = {
      user_version: db.prepare("PRAGMA user_version").get().user_version,
      schema_version: db.prepare("PRAGMA schema_version").get().schema_version,
      journal_mode: db.prepare("PRAGMA journal_mode").get().journal_mode,
      integrity: db.prepare("PRAGMA integrity_check").all().map((r) => r.integrity_check),
      schema, tables: {},
    };
    for (const t of schema.filter((s) => s.type === "table")) out.tables[t.name] = db.prepare(`SELECT rowid AS _rowid, * FROM "${t.name}"`).all();
    writeFileSync(file, JSON.stringify(out, null, 1));
    return out;
  } finally { db.close(); }
}

export const schemaOnly = (d) => JSON.stringify(d.schema?.map((s) => [s.type, s.name, s.sql]));
