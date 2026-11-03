import type { DeliveryCapabilities } from "./input-observation.js";
import type { WakeDispatchPort } from "./session-message-wake-port.js";
import { antigravityQueueWakePort } from "./wake-transport-antigravity.js";
import { claudeInboxWakePort } from "./wake-transport-claude.js";
import { codexQueueWakePort } from "./wake-transport-codex.js";

/** idleWake none is reported as unsupported from the declaration; the relay never dispatches it. */
function deferredWakePort(): WakeDispatchPort {
  return {
    capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" },
    resendBaseMs: 10 * 60_000, // Unused: a port that is never dispatched has no resend; the field is required.
    dispatch: async () => { throw new Error("Deferred wake transport has no idle wake."); },
  };
}

// Composition boundary only: the common port module never imports a vendor transport.
const ports: ReadonlyMap<string, WakeDispatchPort> = new Map<string, WakeDispatchPort>([
  ["claude-inbox", claudeInboxWakePort],
  ["codex-queue", codexQueueWakePort],
  ["codex-deferred", deferredWakePort()],
  ["gemini-deferred", deferredWakePort()],
  ["antigravity-queue", antigravityQueueWakePort],
]);
export const WAKE_TRANSPORTS: readonly string[] = Object.freeze([...ports.keys()]);
export function transportWakePort(transport: string): WakeDispatchPort {
  const port = ports.get(transport);
  if (!port) throw new Error("Wake transport adapter is unavailable.");
  return port;
}
export function transportDeliveryCapabilities(transport: string): DeliveryCapabilities {
  const capabilities = transportWakePort(transport).capabilities;
  return { supportedInjection: [...capabilities.supportedInjection], idleWake: capabilities.idleWake };
}
