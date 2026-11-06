// Trial-only additive observer. It neither reads host history nor supplies model instructions.
import { appendFileSync, readFileSync } from "node:fs";
const input = JSON.parse(readFileSync(0, "utf8"));
if (!process.env.CUE_LIFECYCLE_FILE) throw new Error("CUE_LIFECYCLE_FILE is required");
appendFileSync(process.env.CUE_LIFECYCLE_FILE, JSON.stringify({ event: input.hook_event_name ?? null,
  source: input.source ?? null, sessionId: input.session_id ?? null, at: new Date().toISOString() }) + "\n");
process.stdout.write("{}");
