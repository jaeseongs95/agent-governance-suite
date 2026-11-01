import type { DatabaseSync } from "node:sqlite";
export declare const V2_WAKE_STATE_CHECK: string;
export declare const V2_ACTIVE_WAKE_STATES: string;
export declare const V2_MESSAGING_TABLES: string[];
export declare const V2_SCHEMA_SQL: string[];
export declare const V2_WAKE_COLUMNS: string[];
export declare function applyV2Schema(db: DatabaseSync, options?: { setUserVersion?: boolean }): void;
export declare function insertV2WakeRows(db: DatabaseSync, rows: Array<Record<string, unknown>>): void;
export declare function buildV2Database(path: string, rows?: {
  presence?: Array<Record<string, unknown>>; relays?: Array<Record<string, unknown>>;
  wakes?: Array<Record<string, unknown>>; activity?: Array<{ host: string; session_id: string; active_at: string }>;
}): void;
