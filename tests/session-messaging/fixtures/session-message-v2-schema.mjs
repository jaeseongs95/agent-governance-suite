// The 2.x (schema 2) session message layout, copied from c5343231:mcp-server/src/session-message-store.ts.
// The statements run in the order the 2.x constructor ran them, so the produced file has the same tables,
// columns, CHECKs, partial index and user_version as a database last written by a 2.x broker.
// Synthetic fixture only: it carries no operational data.
import { DatabaseSync } from 'node:sqlite';

export const V2_WAKE_STATE_CHECK = "CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted', 'expired-unobserved'))";
export const V2_ACTIVE_WAKE_STATES = "('reserved', 'started', 'submitted', 'unknown')";
export const V2_MESSAGING_TABLES = ['messages', 'relay_leases', 'wake_nonces', 'session_presence', 'prepared_messages', 'input_observations', 'session_activity'];

export const V2_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      sender_host TEXT NOT NULL,
      sender_session_id TEXT NOT NULL,
      target_host TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      body TEXT NOT NULL,
      body_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claimed_at TEXT,
      claim_until TEXT,
      delivery_attempts INTEGER NOT NULL DEFAULT 0,
      first_delivered_at TEXT,
      acknowledged_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS messages_target_pending
      ON messages (target_host, target_session_id, acknowledged_at, expires_at, claim_until);
    CREATE TABLE IF NOT EXISTS relay_leases (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      relay_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      parent_pid INTEGER NOT NULL,
      relay_start_token TEXT,
      relay_code_digest TEXT,
      relay_code_id TEXT,
      lease_until TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, session_id, transport)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS session_presence (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      transport TEXT NOT NULL,
      wake_visibility TEXT NOT NULL CHECK (wake_visibility IN ('silent', 'user-message', 'none')),
      can_wake_silently INTEGER NOT NULL CHECK (can_wake_silently IN (0, 1)),
      supported_injection TEXT NOT NULL DEFAULT '[]',
      idle_wake TEXT NOT NULL DEFAULT 'none' CHECK (idle_wake IN ('silent', 'user-message', 'none')),
      collaboration_id TEXT,
      workspace_id TEXT,
      role TEXT,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      PRIMARY KEY (host, session_id, instance_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS session_presence_latest
      ON session_presence (host, session_id, started_at DESC);`,
  `CREATE TABLE IF NOT EXISTS prepared_messages (
        message_id TEXT PRIMARY KEY,
        sender_host TEXT NOT NULL,
        sender_session_id TEXT NOT NULL,
        target_host TEXT NOT NULL,
        target_session_id TEXT NOT NULL,
        body TEXT,
        ttl_seconds INTEGER NOT NULL,
        prepared_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        receipt TEXT,
        record_bytes INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS prepared_messages_expiry ON prepared_messages (expires_at);
      CREATE INDEX IF NOT EXISTS prepared_messages_owner ON prepared_messages (sender_host, sender_session_id, receipt);`,
  'ALTER TABLE messages ADD COLUMN legacy_claim_attempt INTEGER NOT NULL DEFAULT 0;',
  `ALTER TABLE messages ADD COLUMN claim_receipt TEXT
          CHECK ((claim_receipt IS NULL AND delivery_attempts <= legacy_claim_attempt) OR (claim_receipt IS NOT NULL AND delivery_attempts > 0
            AND substr(claim_receipt, 1, instr(claim_receipt, ':') - 1) = CAST(delivery_attempts AS TEXT)));`,
  `ALTER TABLE messages ADD COLUMN acknowledgement_receipt TEXT
          CHECK (acknowledged_at IS NULL OR claim_receipt IS NULL
            OR coalesce(acknowledgement_receipt = claim_receipt, 0));`,
  'ALTER TABLE session_presence ADD COLUMN verified_parent_pid INTEGER;',
  'ALTER TABLE session_presence ADD COLUMN verified_parent_token TEXT;',
  'ALTER TABLE session_presence ADD COLUMN superseded_at TEXT;',
  'ALTER TABLE session_presence ADD COLUMN reported_parent_pid INTEGER;',
  'ALTER TABLE session_presence ADD COLUMN reported_parent_token TEXT;',
  `CREATE TABLE IF NOT EXISTS input_observations (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        deferred_tool_claim INTEGER NOT NULL DEFAULT 0 CHECK (deferred_tool_claim IN (0, 1)),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      ) STRICT;`,
  // Schema 1 rebuild result, then the schema 2 prior_unobserved column.
  `CREATE TABLE wake_nonces (
          nonce_digest TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT,
          state TEXT NOT NULL DEFAULT 'legacy' ${V2_WAKE_STATE_CHECK},
          nonce TEXT, instance_id TEXT, birth_generation TEXT, transport TEXT, relay_id TEXT, attempt_id TEXT,
          dispatch_epoch INTEGER NOT NULL DEFAULT 0, retry_not_before TEXT, retry_count INTEGER NOT NULL DEFAULT 0,
          started_at TEXT, outcome_at TEXT, observed_at TEXT, late_observed_at TEXT, retired_at TEXT
        ) STRICT;`,
  'ALTER TABLE wake_nonces ADD COLUMN prior_unobserved INTEGER NOT NULL DEFAULT 0 CHECK (prior_unobserved IN (0, 1));',
  `CREATE UNIQUE INDEX IF NOT EXISTS wake_active_target ON wake_nonces (host, session_id)
        WHERE state IN ${V2_ACTIVE_WAKE_STATES};`,
  `CREATE TABLE IF NOT EXISTS session_activity (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        active_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      ) STRICT;`,
];

export const V2_WAKE_COLUMNS = ['nonce_digest', 'host', 'session_id', 'expires_at', 'consumed_at', 'state', 'nonce', 'instance_id',
  'birth_generation', 'transport', 'relay_id', 'attempt_id', 'dispatch_epoch', 'retry_not_before', 'retry_count', 'started_at',
  'outcome_at', 'observed_at', 'late_observed_at', 'retired_at', 'prior_unobserved'];

/** Applies the schema 2 layout to an open connection (standalone file or a downgraded shared file). */
export function applyV2Schema(db, { setUserVersion = true } = {}) {
  for (const sql of V2_SCHEMA_SQL) db.exec(sql);
  if (setUserVersion) db.exec('PRAGMA user_version = 2;');
}

/** Inserts wake rows given as objects keyed by V2_WAKE_COLUMNS (missing keys use the column default). */
export function insertV2WakeRows(db, rows) {
  for (const row of rows) {
    const keys = Object.keys(row);
    for (const key of keys) if (!V2_WAKE_COLUMNS.includes(key)) throw new Error(`unknown v2 wake column ${key}`);
    db.prepare(`INSERT INTO wake_nonces (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(key => row[key]));
  }
}

/** Creates a standalone schema 2 file with the supplied presence, relay and wake rows. */
export function buildV2Database(path, { presence = [], relays = [], wakes = [], activity = [] } = {}) {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA journal_mode = WAL;');
    applyV2Schema(db);
    for (const row of presence) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO session_presence (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(key => row[key]));
    }
    for (const row of relays) {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO relay_leases (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(key => row[key]));
    }
    insertV2WakeRows(db, wakes);
    for (const row of activity) db.prepare('INSERT INTO session_activity (host, session_id, active_at) VALUES (?, ?, ?)').run(row.host, row.session_id, row.active_at);
  } finally { db.close(); }
}
