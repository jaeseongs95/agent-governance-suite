import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule, { type FormatsPlugin } from "ajv-formats";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import installRecordSchema from "../../runtime/issuer/windows/contract/install-record.schema.json" with { type: "json" };
import ipcFrameSchema from "../../runtime/issuer/windows/contract/ipc-frame.schema.json" with { type: "json" };

// B14-q-a2 candidate: Windows issuer client adapter. Not wired into the broker or server yet.
// Credential registration/lifecycle meaning belongs to B14-l; this module only frames, authenticates
// the server identity reported by the transport, and maps outcomes fail-closed.

/** Fixed protected location (ags-protected-provisioning/v1 P3.3): never taken from argv, env, cwd or callers. */
export const WINDOWS_ISSUER_INSTALL_RECORD_PATH = "C:\\ProgramData\\agent-governance-suite\\issuer\\install-record.json";
export const WINDOWS_ISSUER_MAX_RESPONSE_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export type IssuerAudience = "peer-receiver/v1" | "resource-caller/v1";
export type IssuerVerdict = "OK" | "REJECTED" | "UNAVAILABLE" | "UNSUPPORTED" | "UNKNOWN";
export interface IssuerCredential {
  credentialId: string;
  audience: IssuerAudience;
  receiverInstance: string;
  expiresAt: string;
  secret: string;
}
export interface IssuerOutcome {
  verdict: IssuerVerdict;
  code: string;
  epoch?: string;
  credential?: IssuerCredential;
}

/** Thrown by a transport only when nothing was sent (no pipe, connection refused). */
export class IssuerEndpointUnavailable extends Error {}

/**
 * Sends one request frame to the record's pipe and returns the reply with the server SID the OS reported
 * for that same connection handle (not a PID lookup, which can be recycled). It must stop reading past
 * WINDOWS_ISSUER_MAX_RESPONSE_BYTES + 1. Node cannot observe the server SID, so the production default is
 * absent and every request stays UNAVAILABLE until B14-q-a3/a6 supply one.
 */
export type IssuerPipeTransport = (pipeName: string, request: Buffer, signal: AbortSignal) => Promise<{ response: Buffer; serverSid: string }>;

interface InstallRecord {
  principals: Record<"installer" | "issuer" | "receiver" | "caller" | "worker", { accountKind: string; accountName: string; observedSid: string }>;
  services: Record<"issuer" | "receiver", { serviceName: string; binaryPath: string }>;
  paths: { installRecord: string; registry: string; stateDirectory: string };
  endpoint: { pipeName: string };
}
interface ResponseFrame {
  requestId: string;
  operation: "epoch" | "issue";
  epoch: string;
  status: "ok" | "rejected" | "unavailable";
  error?: { code: string };
  credential?: IssuerCredential;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
(addFormatsModule as unknown as FormatsPlugin)(ajv);
const validateRecordShape = ajv.compile(installRecordSchema);
ajv.addSchema(ipcFrameSchema);
const validateRequest = ajv.getSchema(`${ipcFrameSchema.$id}#/$defs/request`)!;
const validateResponse = ajv.getSchema(`${ipcFrameSchema.$id}#/$defs/response`)!;

/** Schema plus the cross-field and case-insensitive rules JSON Schema cannot express. Throws on any violation. */
export function validateWindowsIssuerInstallRecord(raw: unknown): InstallRecord {
  if (!validateRecordShape(raw)) throw new Error("Invalid Windows issuer install record.");
  const record = raw as unknown as InstallRecord;
  const { principals: p, services: s, paths } = record;
  if (p.installer.accountKind === "local-system" && p.installer.observedSid !== "S-1-5-18")
    throw new Error("A local-system installer must be observed as S-1-5-18.");
  // Windows paths compare case-insensitively; every protected file and directory is its own object.
  const files = [paths.installRecord, paths.registry, paths.stateDirectory, s.issuer.binaryPath, s.receiver.binaryPath]
    .map(path => path.toLowerCase());
  if (new Set(files).size !== files.length) throw new Error("Protected install paths must be distinct.");
  if (files.some(path => /\\(?:con|prn|aux|nul|com\d|lpt\d)(?:\.[^\\]*)?(?=\\|$)/.test(path)))
    throw new Error("Protected install paths must not name a DOS device.");
  const state = `${files[2]}\\`;
  if (files.slice(3).some(binary => binary.startsWith(state))) throw new Error("Service binaries must stay outside mutable state.");
  const protectedSids = [p.issuer.observedSid, p.receiver.observedSid];
  const otherSids = [p.installer.observedSid, p.caller.observedSid, p.worker.observedSid];
  if (protectedSids[0] === protectedSids[1] || protectedSids.some(sid => otherSids.includes(sid)))
    throw new Error("Issuer and receiver must run as principals distinct from each other and from installer, caller and worker.");
  if (s.issuer.serviceName === s.receiver.serviceName) throw new Error("Issuer and receiver services must differ.");
  for (const role of ["issuer", "receiver"] as const) {
    if (p[role].accountName !== `NT SERVICE\\${s[role].serviceName}`)
      throw new Error(`The ${role} virtual account must belong to its own service.`);
  }
  return record;
}

const outcome = (verdict: IssuerVerdict, code: string, extra: Partial<IssuerOutcome> = {}): IssuerOutcome => ({ verdict, code, ...extra });

export class WindowsIssuerClient {
  #epoch: string | null = null;
  readonly #platform: NodeJS.Platform;
  readonly #readRecord: () => Promise<unknown>;
  readonly #transport: IssuerPipeTransport | undefined;
  readonly #timeoutMs: number;

  constructor(deps: {
    platform?: NodeJS.Platform;
    readRecord?: () => Promise<unknown>;
    transport?: IssuerPipeTransport;
    timeoutMs?: number;
  } = {}) {
    this.#platform = deps.platform ?? process.platform;
    this.#readRecord = deps.readRecord ?? (async () => JSON.parse(await readFile(WINDOWS_ISSUER_INSTALL_RECORD_PATH, "utf8")));
    this.#transport = deps.transport;
    this.#timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** Learns the issuer's current restart epoch. Required before issue and after any epoch change. */
  refreshEpoch(): Promise<IssuerOutcome> {
    return this.#send("epoch", {});
  }

  /** Only audience and receiverInstance are accepted; any other caller field is rejected, not ignored (P5.3). */
  issue(args: unknown): Promise<IssuerOutcome> {
    if (!args || typeof args !== "object" || Array.isArray(args)) return Promise.resolve(outcome("REJECTED", "caller-field-forbidden"));
    const keys = Object.keys(args);
    if (keys.length !== 2 || !keys.includes("audience") || !keys.includes("receiverInstance"))
      return Promise.resolve(outcome("REJECTED", "caller-field-forbidden"));
    const { audience, receiverInstance } = args as { audience: unknown; receiverInstance: unknown };
    return this.#send("issue", { audience, receiverInstance });
  }

  async #send(operation: "epoch" | "issue", args: Record<string, unknown>): Promise<IssuerOutcome> {
    if (this.#platform !== "win32") return outcome("UNSUPPORTED", "platform-unsupported");
    if (!this.#transport) return outcome("UNAVAILABLE", "server-identity-transport-missing");
    let record: InstallRecord;
    try {
      record = validateWindowsIssuerInstallRecord(await this.#readRecord());
    } catch {
      return outcome("UNAVAILABLE", "install-record-invalid");
    }
    if (operation === "issue" && this.#epoch === null) return outcome("UNAVAILABLE", "epoch-unknown");
    const requestId = randomBytes(16).toString("hex");
    const request = { schemaVersion: "1.0.0", kind: "issuer-request", requestId, epoch: operation === "issue" ? this.#epoch : null, operation, ...args };
    if (!validateRequest(request)) return outcome("REJECTED", "caller-field-invalid");

    let reply: { response: Buffer; serverSid: string };
    const signal = AbortSignal.timeout(this.#timeoutMs);
    try {
      // The deadline is ours: a transport that ignores the signal cannot hold the caller forever.
      reply = await Promise.race([
        this.#transport(record.endpoint.pipeName, Buffer.from(`${JSON.stringify(request)}\n`, "utf8"), signal),
        new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      ]);
    } catch (error) {
      // Once bytes may have left, the issuer may have acted: never report that as success or clean failure.
      return error instanceof IssuerEndpointUnavailable && !signal.aborted
        ? outcome("UNAVAILABLE", "endpoint-unavailable") : outcome("UNKNOWN", "transport-uncertain");
    }
    // Same-user squatters can own a pipe name; only the OS-reported server principal authenticates the reply.
    if (reply.serverSid !== record.principals.issuer.observedSid) return outcome("REJECTED", "server-identity-mismatch");
    if (reply.response.length > WINDOWS_ISSUER_MAX_RESPONSE_BYTES) return outcome("UNKNOWN", "response-malformed");
    let frame: ResponseFrame;
    try {
      const parsed: unknown = JSON.parse(reply.response.toString("utf8"));
      if (!validateResponse(parsed)) return outcome("UNKNOWN", "response-malformed");
      frame = parsed as ResponseFrame;
    } catch {
      return outcome("UNKNOWN", "response-malformed");
    }
    if (frame.requestId !== requestId || frame.operation !== operation) return outcome("UNKNOWN", "response-mismatch");

    // Compare with the epoch this request carried, never the live field: a concurrent refresh may have moved it.
    const forget = () => { if (this.#epoch === request.epoch) this.#epoch = null; };
    if (frame.status !== "ok") {
      if (frame.error?.code === "epoch-mismatch") forget();
      return outcome(frame.status === "rejected" ? "REJECTED" : "UNAVAILABLE", frame.error!.code);
    }
    if (operation === "epoch") {
      this.#epoch = frame.epoch;
      return outcome("OK", "epoch-current", { epoch: frame.epoch });
    }
    // An ok issue reply that disagrees with the request means the issuer acted outside the protocol: unknown, not clean.
    const credential = frame.credential!;
    if (frame.epoch !== request.epoch) {
      forget();
      return outcome("UNKNOWN", "response-mismatch");
    }
    if (credential.audience !== args.audience || credential.receiverInstance !== args.receiverInstance)
      return outcome("UNKNOWN", "response-mismatch");
    return outcome("OK", "issued", { epoch: frame.epoch, credential });
  }
}
