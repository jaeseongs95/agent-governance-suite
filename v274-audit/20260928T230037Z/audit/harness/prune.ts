import { SessionMessageStore } from "../mcp-server/src/session-message-store.ts";
const [db, now] = process.argv.slice(2); const s = new SessionMessageStore(db); s.prune(Number(now)); s.close(); console.log("pruned");
