// Shared helpers for CASE=wake-271-state-upgrade. Disposable state only.
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const HOST = 'codex';
export const TRANSPORT = 'codex-queue';
export const CAPS = { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'user-message' };
export const SENDER = { host: 'portable', sessionId: 'exp-sender' };
export const nonce = (tag) => `${tag}-${randomBytes(18).toString('base64url')}`;
export const iso = (ms) => new Date(ms).toISOString();

export async function load(root) {
  const store = await import(join(root, 'mcp-server/src/session-message-store.ts'));
  const port = await import(join(root, 'mcp-server/src/session-message-wake-port.ts'));
  const adapter = await import(join(root, 'mcp-server/src/host-input-adapter.ts'));
  return { ...store, ...port, ...adapter };
}

export function fileHashes(dir) {
  const out = {};
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (!statSync(p).isFile()) continue;
    out[name] = { bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') };
  }
  return out;
}

/** Schema dump through a caller-provided connection (or a read-only one). */
export function schemaDump(db) {
  return {
    user_version: db.prepare('PRAGMA user_version').get().user_version,
    journal_mode: db.prepare('PRAGMA journal_mode').get().journal_mode,
    objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_autoindex%' ORDER BY type, name").all(),
    wake_nonces_columns: db.prepare('PRAGMA table_info(wake_nonces)').all(),
  };
}

const mask = (v) => (typeof v === 'string' ? `${v.slice(0, 10)}…(${v.length})` : v);
export function rowsDump(db) {
  return {
    wake_nonces: db.prepare('SELECT rowid, * FROM wake_nonces ORDER BY session_id, rowid').all()
      .map((r) => ({ ...r, nonce_digest: mask(r.nonce_digest), nonce: mask(r.nonce) })),
    messages: db.prepare(`SELECT message_id, target_session_id, created_at, expires_at, claimed_at, claim_until,
      delivery_attempts, acknowledged_at FROM messages ORDER BY target_session_id, created_at`).all(),
    session_presence: db.prepare(`SELECT session_id, instance_id, transport, started_at, heartbeat_at, lease_until, ended_at, end_reason
      FROM session_presence ORDER BY session_id, started_at`).all(),
    relay_leases: db.prepare('SELECT session_id, transport, relay_id, lease_until FROM relay_leases ORDER BY session_id').all(),
  };
}

/** Logical content hash across all user tables (row order by rowid). */
export function logicalDigest(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const h = createHash('sha256');
  const perTable = {};
  for (const { name } of tables) {
    const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    const t = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    perTable[name] = { rows: rows.length, sha256: t };
    h.update(name).update(t);
  }
  const schema = createHash('sha256').update(JSON.stringify(db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all())).digest('hex');
  return { schema_sha256: schema, tables: perTable, all_sha256: h.update(schema).digest('hex') };
}

export function openReadOnly(path) {
  return new DatabaseSync(path, { readOnly: true });
}

export function observe(m, target, n, nowMs, extraPrompt = '') {
  const observation = m.adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
    agent_id: '', prompt: `[agent-governance-suite:wake:${n}]${extraPrompt}` }, target.host).observation;
  const sourceReceiptId = m.recordWakeHookObservation(observation, nowMs);
  return { observation, sourceReceiptId };
}

export { existsSync };
