import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { resolveSessionMessageStateDirectory } from "../runtime-config.js";
import { requestSessionMessageOnce } from "../session-message-client.js";
import { RESOURCE_ADMISSION_FEATURE, RESOURCE_BROKER_OPERATION,
  negotiateResourceAdmission, validateResourceBrokerRequest, validateResourceBrokerResult,
  type ResourceBrokerOperation, type ResourceBrokerOperations, type ResourceBrokerRequestV1,
  type ResourceBrokerResultV1 } from "./broker-protocol.js";

export type ResourceClientOperation = Exclude<ResourceBrokerOperation, "collect-observation">;

/** These are local client outcomes, not new broker wire or authority states.
 * `not-invoked` means this client never called the resource operation. Once it
 * calls transport, every failure has an unknown effect: transport exposes no
 * write status. Neither abort nor a failure authorizes release or retry.
 * A resource-result proves only wire shape/binding and, for a receipt, local
 * non-expiry. MAC, realm, lease, grant and ticket checks remain owner gates. */
export type ResourceClientResult<O extends ResourceClientOperation = ResourceClientOperation> =
  | ResourceBrokerResultV1<O>
  | { kind: "invalid-request"; effect: "not-invoked"; error: unknown }
  | { kind: "unsupported"; effect: "not-invoked" }
  | { kind: "stale-receipt"; effect: "unknown"; requestId: string; operation: O }
  | ({ kind: "timeout" | "transport-failure" | "protocol-failure"; requestId: string;
    operation: O; error: unknown } & (
      | { phase: "negotiation"; effect: "not-invoked" }
      | { phase: "operation"; effect: "unknown" }));

export type ResourceClientTransport = (operation: string, payload: Record<string, unknown>,
  stateDirectory: string, timeoutMs: number, signal: AbortSignal) => Promise<unknown>;

/** Owning-service dependencies only; these options are never an MCP input. */
interface ResourceClientOptions {
  request?: ResourceClientTransport;
  stateDirectory?: string;
  timeoutMs?: number;
}

/** Unregistered internal façade. Ping checks feature availability, never caller
 * authorization. The local reader/owner allowlist validates shape only; B14-b/e
 * must still bind the real caller grant/ticket before this can be wired in.
 * Never use sessionMessageRequest here: its reconnect path resends requests. */
export async function requestResourceOperation<O extends ResourceClientOperation>(operation: O,
  args: ResourceBrokerOperations[O]["request"], options: ResourceClientOptions = {},
): Promise<ResourceClientResult<O>> {
  const requestId = randomUUID();
  let wire: ResourceBrokerRequestV1;
  const requestedTimeout = options.timeoutMs ?? 1500;
  try {
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new Error("Resource client timeout must be positive and finite.");
    }
    // Snapshot before the first await so the caller cannot change validated args.
    wire = validateResourceBrokerRequest({ schemaVersion: "1.0.0",
      feature: RESOURCE_ADMISSION_FEATURE, requestId, operation, args: structuredClone(args) },
    true, operation.startsWith("read-") ? "reader" : "owner");
  } catch (error) {
    return { kind: "invalid-request", effect: "not-invoked", error };
  }

  // requestSessionMessageOnce caps each exchange at 2500ms. Use that same bound
  // for the whole ping+operation so a transport timeout cannot outlive our clock.
  const timeoutMs = Math.min(requestedTimeout, 2500);
  const deadline = performance.now() + timeoutMs;
  const controller = new AbortController();
  const timeoutError = new Error("The resource client deadline expired.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(timeoutError); reject(timeoutError); }, timeoutMs);
  });
  const request = options.request ?? requestSessionMessageOnce;
  const directory = options.stateDirectory ?? resolveSessionMessageStateDirectory();
  let phase: "negotiation" | "operation" = "negotiation";
  function remaining(): number {
    const budget = deadline - performance.now();
    if (controller.signal.aborted || budget <= 0) throw timeoutError;
    return budget;
  }
  async function call(command: string, payload: Record<string, unknown>): Promise<unknown> {
    const value = await Promise.race([request(command, payload, directory, remaining(), controller.signal), expired]);
    remaining(); // Reject a late reply even when the timeout callback was delayed.
    return value;
  }
  function failure(kind: "timeout" | "transport-failure" | "protocol-failure",
    error: unknown): ResourceClientResult<O> {
    return phase === "negotiation"
      ? { kind, requestId, operation, error, phase: "negotiation", effect: "not-invoked" }
      : { kind, requestId, operation, error, phase: "operation", effect: "unknown" };
  }
  try {
    const ping = await call("ping", {});
    try {
      if (!negotiateResourceAdmission(ping)) return { kind: "unsupported", effect: "not-invoked" };
    } catch (error) {
      return failure("protocol-failure", error);
    }
    remaining();
    phase = "operation";
    const raw = await call(RESOURCE_BROKER_OPERATION, wire);
    try {
      const result = validateResourceBrokerResult(raw, wire) as ResourceBrokerResultV1<O>;
      if (operation === "issue-receipt") {
        const receipt = result.result as ResourceBrokerOperations["issue-receipt"]["result"];
        if (Date.parse(receipt.expiresAt) <= Date.now()) {
          return { kind: "stale-receipt", effect: "unknown", requestId, operation };
        }
      }
      return result;
    } catch (error) {
      return failure("protocol-failure", error);
    }
  } catch (error) {
    return failure(error === timeoutError || controller.signal.aborted ? "timeout" : "transport-failure", error);
  } finally {
    clearTimeout(timer);
  }
}
