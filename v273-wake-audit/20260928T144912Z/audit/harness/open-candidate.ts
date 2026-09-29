// Run from the candidate worktree: open (migrate) a DB, optionally prune at a given time.
import { SessionMessageStore } from "../mcp-server/src/session-message-store.ts";
const [database, pruneAt] = process.argv.slice(2);
const s = new SessionMessageStore(database);
if (pruneAt) s.prune(Number(pruneAt));
s.close();
console.log("opened");
