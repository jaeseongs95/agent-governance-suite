import type { DatabaseSync } from "node:sqlite";

export interface BoardSession {
  host: string;
  sessionId: string;
  cwd: string;
  now: string;
}

export interface SessionView {
  host: string;
  sessionId: string;
  cwd: string;
  summary: string | null;
  summaryAt: string | null;
  lastPromptAt: string | null;
  startedAt: string;
  updatedAt: string;
  stale: boolean;
  current: boolean;
}

export const SUMMARY_MAX_LENGTH: number;
export function openBoard(databasePath: string, options?: { busyTimeoutMs?: number }): DatabaseSync;
export function touchSession(db: DatabaseSync, session: BoardSession): void;
export function recordPrompt(db: DatabaseSync, session: BoardSession): void;
export function normalizeSummary(value: unknown): string | null;
export function setSummary(db: DatabaseSync, session: BoardSession, summary: unknown): string;
export function gateDecision(db: DatabaseSync, session: BoardSession): "allow" | "deny";
export function pruneSessions(db: DatabaseSync, now: string): void;
export function readSession(db: DatabaseSync, host: string, sessionId: string): SessionView | null;
export function listSessions(db: DatabaseSync, now: string, current?: { host: string; sessionId: string } | null): SessionView[];
export function isReadOnlyCommand(command: unknown): boolean;
