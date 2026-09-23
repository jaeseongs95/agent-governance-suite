import type { DatabaseSync } from "node:sqlite";

import { canonicalDatabasePath } from "../runtime-config.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";

const SCHEMA_VERSION = 1;
const TABLES = [
  "resource_authority", "resource_pools", "resource_observations",
  "resource_window_observations", "resource_reservations", "resource_reservation_holds",
  "resource_admission_requests",
  "resource_intents", "resource_usage_events", "resource_terminal_evidence", "resource_usage_coverage",
] as const;

/** Initialize only an empty resource database; never migrate another ledger in place. */
export function initializeResourceStoreSchema(database: DatabaseSync, authority: ResourceAuthorityConfig): void {
  const opened = (database.prepare("PRAGMA database_list").all() as Array<{ name: string; file: string }>).find(row => row.name === "main");
  if (!opened?.file || canonicalDatabasePath(opened.file, process.platform)
    !== canonicalDatabasePath(authority.databasePath, process.platform)) {
    throw new Error("Resource connection is not the configured database.");
  }
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
  try {
    const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === 0) {
      const objects = database.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type IN ('table','view','index','trigger')").all();
      if (objects.length) throw new Error("Unrecognized database cannot become the resource ledger.");
      database.exec(`
        CREATE TABLE resource_authority (
          id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL CHECK (schema_version = 1),
          realm_id TEXT NOT NULL, authority_id TEXT NOT NULL, owner_mode TEXT NOT NULL CHECK (owner_mode = 'single-broker')
        ) STRICT;
        CREATE TABLE resource_pools (
          account_scope TEXT NOT NULL, pool_id TEXT NOT NULL, access_path TEXT NOT NULL,
          PRIMARY KEY (account_scope, pool_id)
        ) STRICT;
        CREATE TABLE resource_observations (
          observation_id TEXT PRIMARY KEY, account_scope TEXT NOT NULL, pool_id TEXT NOT NULL,
          collector_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK (sequence >= 0),
          payload_digest TEXT NOT NULL, payload_json TEXT NOT NULL,
          UNIQUE (account_scope, pool_id, collector_id, sequence),
          UNIQUE (observation_id, account_scope, pool_id),
          FOREIGN KEY (account_scope, pool_id) REFERENCES resource_pools(account_scope, pool_id)
        ) STRICT;
        CREATE TABLE resource_window_observations (
          account_scope TEXT NOT NULL, pool_id TEXT NOT NULL, window_id TEXT NOT NULL,
          observation_id TEXT NOT NULL,
          reset_epoch INTEGER NOT NULL CHECK (reset_epoch >= 0), revision INTEGER NOT NULL CHECK (revision >= 0),
          bucket_id TEXT NOT NULL, unit TEXT NOT NULL, remaining REAL,
          observed_at TEXT NOT NULL, expires_at TEXT NOT NULL,
          PRIMARY KEY (account_scope, pool_id, window_id),
          FOREIGN KEY (account_scope, pool_id) REFERENCES resource_pools(account_scope, pool_id),
          FOREIGN KEY (observation_id, account_scope, pool_id)
            REFERENCES resource_observations(observation_id, account_scope, pool_id)
        ) STRICT;
        CREATE TABLE resource_reservations (
          reservation_id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, request_digest TEXT NOT NULL,
          task_id TEXT NOT NULL, run_id TEXT NOT NULL, slot_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
          plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0), lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 0),
          state TEXT NOT NULL CHECK (state IN ('held','committed','settled','released','uncertain')),
          created_at TEXT NOT NULL, expires_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE resource_reservation_holds (
          reservation_id TEXT NOT NULL REFERENCES resource_reservations(reservation_id),
          account_scope TEXT NOT NULL, pool_id TEXT NOT NULL, window_id TEXT NOT NULL,
          reset_epoch INTEGER NOT NULL CHECK (reset_epoch >= 0), amount REAL NOT NULL CHECK (amount >= 0), unit TEXT NOT NULL,
          PRIMARY KEY (reservation_id, account_scope, pool_id, window_id),
          FOREIGN KEY (account_scope, pool_id) REFERENCES resource_pools(account_scope, pool_id)
        ) STRICT;
        CREATE TABLE resource_admission_requests (
          request_key TEXT PRIMARY KEY, request_digest TEXT NOT NULL,
          plan_revision INTEGER NOT NULL CHECK (plan_revision >= 0), request_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('pending','admitted','rejected','deferred')),
          result_json TEXT, reservation_id TEXT UNIQUE REFERENCES resource_reservations(reservation_id)
        ) STRICT;
        CREATE TABLE resource_intents (
          intent_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL UNIQUE REFERENCES resource_reservations(reservation_id),
          request_digest TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE resource_usage_events (
          event_id TEXT NOT NULL, reservation_id TEXT NOT NULL REFERENCES resource_reservations(reservation_id),
          account_scope TEXT NOT NULL, pool_id TEXT NOT NULL, window_id TEXT NOT NULL,
          amount REAL CHECK (amount >= 0), unit TEXT NOT NULL, basis TEXT NOT NULL,
          coverage TEXT NOT NULL, job_binding_digest TEXT NOT NULL,
          source_digest TEXT NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
          PRIMARY KEY (event_id, account_scope, pool_id, window_id),
          FOREIGN KEY (reservation_id, account_scope, pool_id, window_id)
            REFERENCES resource_reservation_holds(reservation_id, account_scope, pool_id, window_id)
        ) STRICT;
        CREATE TABLE resource_terminal_evidence (
          evidence_id TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES resource_reservations(reservation_id),
          job_binding_digest TEXT NOT NULL, result TEXT NOT NULL, evidence_digest TEXT NOT NULL,
          payload_json TEXT NOT NULL, observed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE resource_usage_coverage (
          reservation_id TEXT NOT NULL REFERENCES resource_reservations(reservation_id),
          account_scope TEXT NOT NULL, pool_id TEXT NOT NULL, window_id TEXT NOT NULL,
          coverage TEXT NOT NULL, observed_amount REAL CHECK (observed_amount >= 0),
          unit TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (reservation_id, account_scope, pool_id, window_id),
          FOREIGN KEY (reservation_id, account_scope, pool_id, window_id)
            REFERENCES resource_reservation_holds(reservation_id, account_scope, pool_id, window_id)
        ) STRICT;
      `);
      database.prepare("INSERT INTO resource_authority VALUES (1,?,?,?,?)")
        .run(SCHEMA_VERSION, authority.realmId, authority.authorityId, authority.ownerMode);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    } else if (version === SCHEMA_VERSION) {
      const present = new Set((database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
      if (TABLES.some(table => !present.has(table))) throw new Error("Resource ledger schema is incomplete.");
      const marker = database.prepare("SELECT schema_version, realm_id, authority_id, owner_mode FROM resource_authority WHERE id = 1").get() as
        { schema_version: number; realm_id: string; authority_id: string; owner_mode: string } | undefined;
      if (marker?.schema_version !== SCHEMA_VERSION || marker.realm_id !== authority.realmId
        || marker.authority_id !== authority.authorityId || marker.owner_mode !== authority.ownerMode) {
        throw new Error("Resource authority realm or identity mismatch.");
      }
    } else {
      throw new Error(`Unsupported resource ledger schema version: ${version}.`);
    }
    database.exec("COMMIT;");
  } catch (error) {
    try { database.exec("ROLLBACK;"); } catch { /* Keep the original schema failure. */ }
    throw error;
  }
}
