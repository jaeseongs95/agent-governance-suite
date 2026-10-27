export const SESSION_MESSAGE_PROTOCOL = "1.0.0";

// The lock publisher and diagnostic allowlist share the same fixed retry codes.
export const BROKER_LOCK_PUBLISH_RETRY_CODES: readonly string[] = Object.freeze(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOENT"]);

// Fixed producer reasons also define the startup diagnostic allowlist.
export const BROKER_LOCK_REASONS = Object.freeze({
  BUDGET_EXPIRED: "BUDGET_EXPIRED", OWNER_UNVERIFIED: "OWNER_UNVERIFIED", UNSUPPORTED_PATH: "UNSUPPORTED_PATH",
  EMPTY_DIRECTORY: "EMPTY_DIRECTORY", UNRECOGNIZED_OWNER: "UNRECOGNIZED_OWNER", CHANGED: "CHANGED",
  PREPARATION_CLEANUP_FAILED: "PREPARATION_CLEANUP_FAILED",
} as const);
export const BROKER_IDENTITY_BUDGET_CODES = Object.freeze({
  EXPIRED: "BROKER_IDENTITY_BUDGET_EXPIRED", INVALID: "BROKER_IDENTITY_BUDGET_INVALID",
} as const);

// Only these stable codes may cross the startup diagnostic pipe.
const BROKER_STARTUP_CODES = new Set([
  "EACCES", "EPERM", "ENOENT", "ENOSPC", "EMFILE", "ENFILE", "EADDRINUSE", "ETIMEDOUT",
  "SQLITE_BUSY", "SQLITE_CANTOPEN", "SQLITE_CORRUPT", "SQLITE_IOERR", "SQLITE_READONLY",
  ...Object.values(BROKER_LOCK_REASONS).map((reason) => "BROKER_LOCK_" + reason),
  ...Object.values(BROKER_IDENTITY_BUDGET_CODES),
  ...BROKER_LOCK_PUBLISH_RETRY_CODES.map((code) => "BROKER_LOCK_PUBLISH_" + code),
  "STARTUP_FAILED",
]);
export function brokerStartupCode(value: unknown): string | null {
  return typeof value === "string" && BROKER_STARTUP_CODES.has(value) ? value : null;
}
export const SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
export const SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;
export const SESSION_MESSAGE_BODY_MAX_BYTES = 4096;
/** Identities per list-presence request; worst-case presence views of this many still fit the response limit. */
export const SESSION_PRESENCE_LIST_MAX_TARGETS = 3;

/** The only identifier shapes the broker accepts; callers skip anything else rather than send it. */
export function isBoundedIdentity(value: { host: string; sessionId: string }): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.host) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.sessionId);
}
export const SESSION_MESSAGE_HOOK_CONTEXT_MAX_BYTES = 8192;

/**
 * Reads one newline-terminated frame from raw socket chunks. The limit counts the line's raw bytes with its newline, as
 * the sender measured it, and the line is decoded once, so a character split across chunks (TLS hands over at most
 * 16384 bytes at a time) stays whole. Returns the line without its newline, or null until it is complete; throws once
 * the line passes the limit. After a line the reader starts empty, dropping bytes that followed it in the same chunk.
 */
export function sessionMessageLineReader(limitBytes: number): (chunk: Buffer) => string | null {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const newline = pending.indexOf(0x0a);
    if ((newline < 0 ? pending.length : newline + 1) > limitBytes) throw new RangeError("The session message line exceeds its limit.");
    if (newline < 0) return null;
    const line = pending.toString("utf8", 0, newline);
    pending = Buffer.alloc(0);
    return line;
  };
}
