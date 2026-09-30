// Test-only broker preload: a claim for the session "over-by-one" gets one ASCII byte appended to its last body after
// the store has fitted the answer to the response limit, so the broker sends a line one byte over that limit.
import { SessionMessageStore } from "../../../mcp-server/src/session-message-store.ts";

const claim = SessionMessageStore.prototype.claim;
SessionMessageStore.prototype.claim = function (target, ...rest) {
  const messages = claim.call(this, target, ...rest);
  if (target.sessionId === "over-by-one" && messages.length > 0) messages[messages.length - 1].body += "x";
  return messages;
};
