import { reportRelayFailure, runSessionMessageRelay } from "./session-message-relay.js";

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
const relayIdArguments = process.argv.filter(value => value === "--relay-id").length;
const relayId = argument("--relay-id");
const invalidRelayId = relayIdArguments > 1 || (relayIdArguments === 1 && (!relayId || !/^verified-relay-v1:[0-9a-f-]{36}:[0-9a-f]{64}$/u.test(relayId)));

if (invalidRelayId || !host || !sessionId || !instanceId || (transport !== "codex-deferred" && transport !== "codex-queue" && transport !== "claude-inbox" && transport !== "gemini-queue") || !Number.isInteger(parentPid) || !parentStartToken) process.exitCode = 2;
else void runSessionMessageRelay({ host, sessionId, instanceId, transport, parentPid, parentStartToken, ...(relayId ? {relayId}:{}) }).catch((error: unknown) => { reportRelayFailure("run", error); process.exitCode = 1; });
