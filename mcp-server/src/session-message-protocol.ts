export const SESSION_MESSAGE_PROTOCOL = "1.0.0";
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
