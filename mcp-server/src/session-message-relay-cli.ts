import { producerFailure } from "./failure-diagnostics.js";
import { reportRelayFailure, runSessionMessageRelay } from "./session-message-relay.js";
import { WAKE_TRANSPORTS } from "./wake-transports.js";

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

if (invalidRelayId || !host || !sessionId || !instanceId || !transport || !WAKE_TRANSPORTS.includes(transport) || !Number.isInteger(parentPid) || !parentStartToken) {
  // The spawning hook may already have exited and its stdio is ignored: keep a fixed-reason local record.
  reportRelayFailure("arguments", producerFailure("RELAY_ARGUMENTS_REJECTED", "The relay arguments were rejected."));
  process.exitCode = 2;
} else void runSessionMessageRelay({ host, sessionId, instanceId, transport, parentPid, parentStartToken, ...(relayId ? {relayId}:{}), ...(!relayId && process.argv.includes("--recovery") ? {recovery:true}:{}) }).catch((error: unknown) => { reportRelayFailure("run", error); process.exitCode = 1; });
