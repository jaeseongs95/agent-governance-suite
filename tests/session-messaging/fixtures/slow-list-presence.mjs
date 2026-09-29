// Test-only broker preload: every list-presence answer is held back by a fixed busy wait, as on a slow machine. The
// broker's single event loop is blocked for that time, like any synchronous request; the client keeps its own timers.
import { SessionMessageStore } from "../../../mcp-server/src/session-message-store.ts";

const delay = Number(process.env.AGS_TEST_LIST_PRESENCE_DELAY_MS ?? "0");
const listPresence = SessionMessageStore.prototype.listPresence;
SessionMessageStore.prototype.listPresence = function (...args) {
  const until = Date.now() + delay;
  while (Date.now() < until) { /* hold the answer */ }
  return listPresence.apply(this, args);
};
