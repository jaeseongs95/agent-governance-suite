import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { tagProducerFailure, retainFailureCause } from "./failure-diagnostics.js";
import { resolveSessionMessageStateDirectory } from "./runtime-config.js";
import { dispatchSessionMessageOperation } from "./session-message-operations.js";
import { MessageCapacityError, SessionMessageStore } from "./session-message-store.js";
import { createWakeHookObservationReader, type WakeHookObservationReader } from "./session-message-wake-port.js";

export { SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";
export const WAKE_PREFIX = "[agent-governance-suite:wake:";

/**
 * In-process session messaging (docs/ags30-broker-redesign.md 3.1). There is no broker process, socket, lock or
 * endpoint file: each process opens the shared SQLite file once and every operation is one BEGIN IMMEDIATE transaction.
 */

/** A domain rejection of the operation (validation, capacity, unknown ID), not a storage failure. Nothing was written. */
export class BrokerRequestRejected extends Error {
  readonly details: { scope: "sender" | "global"; earliestReleaseAt: string | null } | null;

  constructor(message: string, details: unknown = null) {
    super(message);
    tagProducerFailure(this, "BROKER_REQUEST_REJECTED");
    const record = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : null;
    this.details = record && (record.scope === "sender" || record.scope === "global")
      && (record.earliestReleaseAt === null || typeof record.earliestReleaseAt === "string")
      ? { scope: record.scope, earliestReleaseAt: record.earliestReleaseAt }
      : null;
  }
}

/** Upper bound of one operation's wait for the writer lock; the store itself holds the lock only for synchronous work. */
export const SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 5_000;
const BUSY_TIMEOUT_MAX_MS = 5_000;

interface OpenMessaging { store: SessionMessageStore; reader: WakeHookObservationReader }
const opened = new Map<string, OpenMessaging>();

function databasePath(stateDirectory: string): string {
  return path.join(stateDirectory, "session-messages.sqlite3");
}

function open(stateDirectory: string, busyTimeoutMs: number, clock?: () => number): OpenMessaging {
  const key = path.resolve(stateDirectory);
  const existing = opened.get(key);
  if (existing) return existing;
  try {
    mkdirSync(key, { recursive: true, mode: 0o700 });
    try { chmodSync(key, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
  } catch (cause) {
    throw retainFailureCause(tagProducerFailure(new Error("Cannot prepare the session message state directory."), "MESSAGING_STATE_DIRECTORY_FAILED"), cause);
  }
  const trustDatabasePath = process.env.AGENT_GOVERNANCE_TRUST_DB_PATH?.trim()
    ? path.resolve(process.env.AGENT_GOVERNANCE_TRUST_DB_PATH.trim()) : path.join(key, "trust.sqlite3");
  const entry = { store: new SessionMessageStore(databasePath(key), { busyTimeoutMs, ...(clock ? { clock } : {}) }), reader: createWakeHookObservationReader(trustDatabasePath) };
  opened.set(key, entry);
  return entry;
}

function isStorageFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("ERR_SQLITE") || code.startsWith("SQLITE"))
    || typeof (error as { errcode?: unknown } | null)?.errcode === "number";
}

function isBusy(error: unknown): boolean {
  const record = error as { errcode?: unknown; message?: unknown } | null;
  return record?.errcode === 5 || record?.errcode === 6 || (typeof record?.message === "string" && /database is (locked|busy)/u.test(record.message));
}

/**
 * Runs one operation in this process. busyTimeoutMs bounds the wait for another process's writer lock (synchronous);
 * a BUSY result means nothing was written, so it is reported as MESSAGING_BUSY and never retried here.
 */
export function runSessionMessageOperation<T>(operation: string, payload: Record<string, unknown>,
  stateDirectory = resolveSessionMessageStateDirectory(), options: { busyTimeoutMs?: number; clock?: () => number } = {}): T {
  const busy = Math.max(0, Math.min(BUSY_TIMEOUT_MAX_MS, Math.floor(options.busyTimeoutMs ?? BUSY_TIMEOUT_MAX_MS)));
  let messaging: OpenMessaging;
  try {
    // The first open may run the schema transaction, so it waits no longer than this call's budget.
    messaging = open(stateDirectory, busy, options.clock);
  } catch (error) {
    if (isBusy(error)) throw retainFailureCause(tagProducerFailure(new Error("Another process holds the session message writer lock."), "MESSAGING_BUSY"), error);
    if (isStorageFailure(error)) throw tagProducerFailure(error as Error, "MESSAGING_STORAGE_FAILED");
    throw error;
  }
  const { store, reader } = messaging;
  try {
    store.database.exec(`PRAGMA busy_timeout = ${busy};`);
    return dispatchSessionMessageOperation(store, operation, payload, reader) as T;
  } catch (error) {
    if (isBusy(error)) throw retainFailureCause(tagProducerFailure(new Error("Another process holds the session message writer lock."), "MESSAGING_BUSY"), error);
    if (error instanceof MessageCapacityError) throw new BrokerRequestRejected(error.message, error.details);
    if (isStorageFailure(error)) throw tagProducerFailure(error as Error, "MESSAGING_STORAGE_FAILED");
    if (error instanceof Error && !(error instanceof BrokerRequestRejected) && (error as { code?: unknown }).code === undefined) {
      throw retainFailureCause(new BrokerRequestRejected(error.message), error);
    }
    throw error;
  }
}

/** Closes this process's connection; a later operation opens it again. */
export function closeSessionMessaging(stateDirectory = resolveSessionMessageStateDirectory()): void {
  const key = path.resolve(stateDirectory);
  opened.get(key)?.store.close();
  opened.delete(key);
}

/**
 * Promise form of runSessionMessageOperation for existing call sites. deadlineMonotonicMs is a same-process
 * performance.now() deadline: an expired deadline runs nothing, and the remaining time bounds the lock wait.
 */
export async function sessionMessageRequest<T>(
  operation: string,
  payload: Record<string, unknown>,
  stateDirectory = resolveSessionMessageStateDirectory(),
  options: {
    totalTimeoutMs?: number;
    prepareStateDirectory?: (directory: string) => Promise<void>;
    deadlineMonotonicMs?: number;
    /** Kept for call sites; there is no transport and therefore no replay. */
    noOperationReplay?: boolean;
    onOperationWrite?: () => void;
  } = {},
): Promise<T> {
  const deadline = Math.min(options.deadlineMonotonicMs ?? Infinity, performance.now() + (options.totalTimeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS));
  const expired = () => tagProducerFailure(new Error("The session message request deadline expired."), "BROKER_DEADLINE_EXPIRED");
  if (!(deadline - performance.now() >= 1)) throw expired();
  if (options.prepareStateDirectory) {
    try { await options.prepareStateDirectory(stateDirectory); }
    catch (cause) { throw retainFailureCause(tagProducerFailure(new Error("Cannot prepare the session message state directory."), "MESSAGING_STATE_DIRECTORY_FAILED"), cause); }
  }
  const remaining = deadline - performance.now();
  if (!(remaining >= 1)) throw expired();
  try { options.onOperationWrite?.(); } catch { /* Observation cannot prevent or replay the operation. */ }
  return runSessionMessageOperation<T>(operation, payload, stateDirectory, { busyTimeoutMs: remaining });
}

export function wakeMessage(nonce: string): string {
  return `${WAKE_PREFIX}${nonce}]`;
}

export function parseWakeMessages(value: unknown): { nonces: string[]; wakeOnly: boolean } {
  if (typeof value !== "string") return { nonces: [], wakeOnly: false };
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const nonces: string[] = [];
  let wakeOnly = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith(WAKE_PREFIX) || !line.endsWith("]")) {
      wakeOnly = false;
      continue;
    }
    const nonce = line.slice(WAKE_PREFIX.length, -1);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) {
      wakeOnly = false;
      continue;
    }
    nonces.push(nonce);
  }
  return { nonces: [...new Set(nonces)], wakeOnly };
}

export function newWakeNonce(): string {
  return randomBytes(24).toString("base64url");
}
