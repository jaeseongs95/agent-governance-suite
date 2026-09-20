import { runSessionMessageRelay } from "./session-message-relay.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const host = argument("--host");
const sessionId = argument("--session-id");
const instanceId = argument("--instance-id");
const transport = argument("--transport");
const parentPid = Number.parseInt(argument("--parent-pid") ?? "", 10);
const parentStartToken = argument("--parent-start-token");

if (!host || !sessionId || !instanceId || (transport !== "codex-deferred" && transport !== "codex-queue" && transport !== "claude-inbox") || !Number.isInteger(parentPid) || !parentStartToken) process.exitCode = 2;
else void runSessionMessageRelay({ host, sessionId, instanceId, transport, parentPid, parentStartToken }).catch(() => { process.exitCode = 1; });
