import type { SharedModuleContext, SqlDatabase } from "../../../runtime/unified-state/shared-connection.mjs";
import type { DatabaseSync } from "node:sqlite";

export interface BoardInput {
  host: string;
  sessionId: string;
  cwd: string | null;
  now: string;
}

export interface BoardEntry {
  cwd: string | null;
  summary: string | null;
  summaryAt: string | null;
  /** The role the user gave the session, as the session wrote it; null when none was written. */
  role: string | null;
  lastPromptAt: string | null;
  summaryStale: boolean | null;
}

export const SUMMARY_MAX_LENGTH: number;
export const ROLE_MAX_LENGTH: number;
export const BOARD_FORMAT_VERSION: number;
export class BoardFormatError extends Error {
  code: "BOARD_FOREIGN_DATABASE";
}
export function openBoard(databasePath: SharedModuleContext, options?: { busyTimeoutMs?: number }): SqlDatabase;
export function openBoard(databasePath: string, options?: { busyTimeoutMs?: number }): DatabaseSync;
export function recordInput(db: SqlDatabase, session: BoardInput, kind: { prompt: boolean }): void;
export function normalizeSummary(value: unknown): string | null;
export function normalizeRole(value: unknown): string | null;
export function setSummary(db: SqlDatabase, session: Omit<BoardInput, "cwd">, summary: unknown, role?: unknown): { summary: string; summaryAt: string; role: string | null };
export function pruneBoard(db: SqlDatabase, now: string): void;
export function readEntry(db: SqlDatabase, host: string, sessionId: string): BoardEntry | null;
export function listPromptMarkers(db: SqlDatabase): Array<{ host: string; sessionId: string; lastPromptAt: string }>;
export function locateRepository(cwd: string | null): { root: string; repoId: string; branch: string | null } | null;
