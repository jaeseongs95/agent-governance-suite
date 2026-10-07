import type { StatementSync } from "node:sqlite";

export type SharedModule = "workflow" | "continuity" | "messaging" | "trust" | "board";
export type SqlStatement = Pick<StatementSync, "get" | "all" | "run">;
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
  readonly inTransaction?: boolean;
  transaction?<T>(operation: () => T): T;
}
export interface SharedModuleContext {
  readonly isShared: true;
  readonly databasePath: string;
  readonly database: SqlDatabase;
  readonly inTransaction: boolean;
  getSchemaVersion(): number;
  setSchemaVersion(version: number): void;
  initialize(operation: () => void): void;
  transaction<T>(operation: () => T): T;
  time(milliseconds: number): number;
}
export class SharedStateError extends Error { readonly code: string; }
export function resolveInactiveSharedDatabasePath(directory: string): string;
export function runObservedTimeTransaction<T>(database: SqlDatabase, observe: () => number, operation: (now: number) => T, afterDomain?: () => void): T;
export class InactiveSharedConnection {
  readonly databasePath: string;
  constructor(options: { databasePath: string; mode: "fixture-only"; clock?: () => number });
  initialize(operation: () => void): void;
  borrow(module: SharedModule): SharedModuleContext;
  transaction<T>(operation: () => T): T;
  inspect(): {
    databasePath: string;
    databases: Array<Record<string, unknown>>;
    userVersion: number;
    modules: Array<{ module: SharedModule; version: number; schema_json: string }>;
    counts: Record<string, number>;
    time: number;
    integrity: Array<Record<string, unknown>>;
    foreignKeyViolations: Array<Record<string, unknown>>;
  };
  close(): void;
}
