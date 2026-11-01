import { producerFailure } from "./failure-diagnostics.js";
import { reportRelayFailure, runSessionMessageRelay } from "./session-message-relay.js";
import { WAKE_TRANSPORTS } from "./wake-transports.js";

function argument(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const once = (name: string) => process.argv.filter(value => value === name).length <= 1;
const host = argument("--host");
const sessionId = argument("--session-id");
const instanceId = argument("--instance-id");
const transport = argument("--transport");
const parentPid = Number.parseInt(argument("--parent-pid") ?? "", 10);
const relayId = argument("--relay-id");
const hostAliveAt = argument("--host-alive-at");
const parentStartToken = argument("--parent-start-token");
const valid = ["--relay-id", "--host-alive-at", "--parent-start-token"].every(once)
  && Boolean(relayId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(relayId))
  && (hostAliveAt === null || /^[0-9]{1,20}$/u.test(hostAliveAt))
  && (parentStartToken === null || (parentStartToken.trim().length > 0 && parentStartToken.length <= 200));

if (!valid || !host || !sessionId || !instanceId || !transport || !WAKE_TRANSPORTS.includes(transport) || !Number.isInteger(parentPid) || parentPid < 1) {
  // The spawning hook may already have exited and its stdio is ignored: keep a fixed-reason local record.
  reportRelayFailure("arguments", producerFailure("RELAY_ARGUMENTS_REJECTED", "The relay arguments were rejected."));
  process.exitCode = 2;
} else void runSessionMessageRelay({ host, sessionId, instanceId, transport, parentPid, relayId: relayId!,
  ...(hostAliveAt ? { hostAliveAt } : {}), ...(parentStartToken ? { parentStartToken } : {}) })
  .catch((error: unknown) => { reportRelayFailure("run", error); process.exitCode = 1; });
