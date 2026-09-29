// Audit-only: the first board lookup starts the broker (no broker running). Usage:
// node --import tsx cold-start-probe.mts <repo> <startup delay ms> <sessions>
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
const [repo, delayArg, countArg] = process.argv.slice(2);
const { SessionMessageService } = await import(pathToFileURL(path.join(repo, "mcp-server/src/session-message-service.ts")).href);
const state = mkdtempSync(path.join(tmpdir(), "ags-v276-cold-"));
process.env.NODE_OPTIONS = `--import ${pathToFileURL(path.join(path.dirname(new URL(import.meta.url).pathname), "startup-delay.mjs")).href}`;
process.env.AGS_AUDIT_BROKER_STARTUP_DELAY_MS = delayArg;
const board = Array.from({ length: Number(countArg) }, (_, index) => ({ host: "portable", sessionId: `cold-${index}` }));
const started = performance.now();
const result = await new SessionMessageService(state).listPresence(board);
const elapsed = Math.round(performance.now() - started);
console.log(JSON.stringify({ probe: "cold-start", startupDelayMs: Number(delayArg), sessions: board.length, elapsedMs: elapsed,
  answered: result.data.sessions.length, unanswered: result.data.unanswered.length, state: path.basename(state) }));
