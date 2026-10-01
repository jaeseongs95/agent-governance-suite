export const SESSION_MESSAGE_PROTOCOL = "1.0.0";
export const SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
export const SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;
export const SESSION_PRESENCE_BATCH_LIMIT = 3;
export const SESSION_PRESENCE_TARGET_LIMIT = 256;
export const SESSION_MESSAGE_BODY_MAX_BYTES = 4096;
export const SESSION_MESSAGE_HOOK_CONTEXT_MAX_BYTES = 8192;

/** The only identifier shapes the broker accepts; callers skip anything else rather than send it. */
export function isBoundedIdentity(value: { host: string; sessionId: string }): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.host) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.sessionId);
}
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
