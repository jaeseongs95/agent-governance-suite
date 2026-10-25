import {spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio} from "node:child_process";
import path from "node:path";
import {z} from "zod";
import {buildVendorMessages, ClassificationProviderError} from "./providers.js";
import {responseSchema, validateClassificationResponse} from "./validation.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillClassificationResponseV1} from "./types.js";

export interface NativeClassificationAdapter {
  capabilityEvidenceRef: string;
  retryPolicy: "no-retry";
  invokeStructured(request: SkillClassificationRequestV1, profile: ProviderProfile, signal: AbortSignal, beforeDispatch?: () => void): Promise<ProviderEvaluation>;
}
export type NativeClassificationAdapterRegistry = ReadonlyMap<string, NativeClassificationAdapter>;

/** CLI help alone does not establish a qualified native route or a verified retry policy. */
export function resolveNativeClassificationAdapter(registry: NativeClassificationAdapterRegistry, ref: string, evidenceRef: string, retryPolicyVerified: boolean): NativeClassificationAdapter | null {
  const adapter = registry.get(ref);
  if (!retryPolicyVerified || !adapter || adapter.capabilityEvidenceRef !== evidenceRef || adapter.retryPolicy !== "no-retry" || typeof adapter.invokeStructured !== "function") return null;
  return adapter;
}

/** Trusted installation data, never supplied by a classification request. No credential fields. */
export interface NativeClassificationAdapterDefinition {
  adapterId: string;
  host: string;
  executable: string;
  workingDirectory: string;
  approvalRef: string;
  capabilityEvidenceRef: string;
  retryPolicyVerified: boolean;
  retryPolicyEvidenceRef: string;
  isolationEvidenceRef: string;
  /** Exact host-vetted arguments preventing tools, hooks and recursive MCP/plugin calls. */
  isolationArgs: readonly string[];
  timeoutMs: number;
  maximumOutputBytes: number;
}
/** Minimum accessible object shape only; no field validation, deep serialization or cloning here. */
export function assertNativeAdapterDataObject(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
}

/** Validate an eligible definition after the caller has excluded incomplete evidence. */
export function assertEligibleNativeAdapterDefinition(value: unknown): void {
  assertNativeAdapterDataObject(value);
  const data = value as Record<string, unknown>;
  if (typeof data.adapterId !== "string" || !data.adapterId || typeof data.host !== "string" || !data.host
    || typeof data.executable !== "string" || !path.isAbsolute(data.executable) || /\.(?:cmd|bat|ps1)$/iu.test(data.executable)
    || typeof data.workingDirectory !== "string" || !path.isAbsolute(data.workingDirectory)
    || !Number.isSafeInteger(data.timeoutMs) || Number(data.timeoutMs) < 1 || Number(data.timeoutMs) > 300000
    || !Number.isSafeInteger(data.maximumOutputBytes) || Number(data.maximumOutputBytes) < 1 || Number(data.maximumOutputBytes) > 1024 * 1024
    || !Array.isArray(data.isolationArgs) || data.isolationArgs.length > 64
    || data.isolationArgs.some(arg => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
  if (typeof data.approvalRef !== "string" || typeof data.capabilityEvidenceRef !== "string"
    || typeof data.retryPolicyVerified !== "boolean" || typeof data.retryPolicyEvidenceRef !== "string" || typeof data.isolationEvidenceRef !== "string") throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
}

export function hasRequiredNativeAdapterEvidence(data: NativeClassificationAdapterDefinition): boolean {
  return Boolean(data.retryPolicyVerified && data.retryPolicyEvidenceRef && data.isolationEvidenceRef && data.approvalRef && data.capabilityEvidenceRef);
}

export interface NativeCliInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  maximumOutputBytes: number;
}
export interface NativeCliOutput {stdout: string; exitCode: number | null}

/** Trusted code only. Encoding ability does not establish actual CLI support or approval. */
export interface NativeCliBehavior {
  validateIsolationArgs(args: readonly string[]): boolean;
  canEncodeProfile(profile: Readonly<ProviderProfile>): boolean;
  prepare(definition: Readonly<NativeClassificationAdapterDefinition>, profile: Readonly<ProviderProfile>, schema: string):
    Promise<{args: readonly string[]; cleanup?: () => Promise<void>}> | {args: readonly string[]; cleanup?: () => Promise<void>};
  decode(output: NativeCliOutput): {response: unknown; usage: ProviderEvaluation["usage"]};
}

/** Data is serializable; callable behavior is supplied separately by trusted in-process code. */
export interface BoundNativeClassificationAdapterDefinition {
  data: NativeClassificationAdapterDefinition;
  behavior?: NativeCliBehavior;
}

export type NativeCliRunner = (invocation: NativeCliInvocation, signal: AbortSignal) => Promise<NativeCliOutput>;
export type NativeCliSpawn = (executable: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

/** One direct child, shell:false, finite combined output, no application retry. */
export function runNativeClassificationCli(invocation: NativeCliInvocation, signal: AbortSignal, spawnProcess: NativeCliSpawn = spawn): Promise<NativeCliOutput> {
  if (signal.aborted) return Promise.reject(new ClassificationProviderError("CANCELLED", "not-started"));
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnProcess(invocation.executable, invocation.args, {cwd: invocation.cwd, shell: false, windowsHide: true, stdio: "pipe"}); }
    catch { reject(new ClassificationProviderError("NATIVE_SPAWN_UNAVAILABLE", "not-started")); return; }
    let outputBytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      child.stdout.removeListener("data", stdout); child.stderr.removeListener("data", stderr);
      // Destruction/termination can emit a late EPIPE; discard it without logging raw details.
      child.on("error", () => {}); child.stdin.on("error", () => {});
      child.removeListener("close", close); child.removeListener("error", error);
      child.stdin.removeListener("error", error);
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    };
    const finish = (failure?: ClassificationProviderError, exitCode: number | null = null) => {
      if (settled) return;
      settled = true;
      if (failure) { try { child.kill("SIGKILL"); } catch { /* Effect remains unknown. */ } }
      cleanup();
      if (failure) reject(failure); else resolve({stdout: Buffer.concat(chunks).toString("utf8"), exitCode});
    };
    const consume = (chunk: Buffer | string, keep: boolean) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.length;
      if (outputBytes > invocation.maximumOutputBytes) { finish(new ClassificationProviderError("NATIVE_OUTPUT_TOO_LARGE", "unknown")); return; }
      if (keep) chunks.push(bytes);
    };
    const stdout = (chunk: Buffer | string) => consume(chunk, true);
    const stderr = (chunk: Buffer | string) => consume(chunk, false);
    const abort = () => finish(new ClassificationProviderError("CANCELLED", "unknown"));
    const error = () => finish(new ClassificationProviderError("NATIVE_PROCESS_UNAVAILABLE", "unknown"));
    const close = (code: number | null) => finish(undefined, code);
    const timer = setTimeout(() => finish(new ClassificationProviderError("NATIVE_TIMEOUT", "unknown")), invocation.timeoutMs);
    child.stdout.on("data", stdout); child.stderr.on("data", stderr);
    child.on("close", close); child.on("error", error); child.stdin.on("error", error);
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    else child.stdin.end(invocation.input);
  });
}


/** Missing approval/capability/retry/isolation evidence registers no route; missing trusted behavior fails explicitly. */
export function createNativeClassificationAdapters(definitions: readonly BoundNativeClassificationAdapterDefinition[], runner: NativeCliRunner = runNativeClassificationCli): NativeClassificationAdapterRegistry {
  if (!Array.isArray(definitions)) throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
  const adapters = new Map<string, NativeClassificationAdapter>();
  const seen = new Set<string>();
  const schema = JSON.stringify(z.toJSONSchema(responseSchema));
  for (const bound of definitions) {
    if (!bound || typeof bound !== "object" || Array.isArray(bound)) throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
    const definition = bound.data;
    assertNativeAdapterDataObject(definition);
    if (seen.has(definition.adapterId)) throw new Error("DUPLICATE_NATIVE_ADAPTER");
    seen.add(definition.adapterId);
    if (!hasRequiredNativeAdapterEvidence(definition)) continue;
    assertEligibleNativeAdapterDefinition(definition);
    const behavior = bound.behavior;
    if (behavior === undefined) throw new Error("NATIVE_ADAPTER_BEHAVIOR_UNAVAILABLE");
    if (!behavior || (typeof behavior !== "object" && typeof behavior !== "function") || typeof behavior.validateIsolationArgs !== "function" || typeof behavior.canEncodeProfile !== "function"
      || typeof behavior.prepare !== "function" || typeof behavior.decode !== "function") throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
    // Clone data only: cloning a callable strategy would fail and would not preserve its provenance.
    let fixed: NativeClassificationAdapterDefinition;
    try { fixed = structuredClone(definition); }
    catch { throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION"); }
    Object.freeze(fixed.isolationArgs); Object.freeze(fixed);
    const strategy = Object.freeze({
      validateIsolationArgs: behavior.validateIsolationArgs.bind(behavior),
      canEncodeProfile: behavior.canEncodeProfile.bind(behavior),
      prepare: behavior.prepare.bind(behavior), decode: behavior.decode.bind(behavior),
    });
    let isolationAllowed: boolean;
    try { isolationAllowed = strategy.validateIsolationArgs(fixed.isolationArgs); }
    catch { throw new Error("NATIVE_ISOLATION_VALIDATION_UNAVAILABLE"); }
    if (isolationAllowed !== true) throw new Error("INVALID_NATIVE_ISOLATION_ARGUMENT");
    adapters.set(fixed.adapterId, {capabilityEvidenceRef: fixed.capabilityEvidenceRef, retryPolicy: "no-retry", async invokeStructured(request, profile, signal, beforeDispatch) {
      if (signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
      const fixedRequest = structuredClone(request);
      let fixedProfile: ProviderProfile;
      try { fixedProfile = structuredClone(profile); }
      catch { throw new ClassificationProviderError("NATIVE_PROFILE_UNSUPPORTED", "not-started"); }
      if (!fixedProfile || typeof fixedProfile !== "object" || Array.isArray(fixedProfile)
        || typeof fixedProfile.modelId !== "string" || typeof fixedProfile.reasoningEffort !== "string"
        || !fixedProfile.supportedOptions || typeof fixedProfile.supportedOptions !== "object" || Array.isArray(fixedProfile.supportedOptions)
        || !Array.isArray(fixedProfile.supportedOptions.reasoningEfforts) || fixedProfile.supportedOptions.structuredOutput !== true
        || !Number.isSafeInteger(fixedProfile.maximumInputBytes) || fixedProfile.maximumInputBytes < 1) throw new ClassificationProviderError("NATIVE_PROFILE_UNSUPPORTED", "not-started");
      Object.freeze(fixedProfile.supportedOptions.reasoningEfforts); Object.freeze(fixedProfile.supportedOptions);
      Object.freeze(fixedProfile.qualification);
      if (fixedProfile.judgmentPolicy) Object.freeze(fixedProfile.judgmentPolicy);
      Object.freeze(fixedProfile);
      if (fixedProfile.providerKind !== "vendor" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(fixedProfile.modelId) || !fixedProfile.reasoningEffort
        || !fixedProfile.supportedOptions.structuredOutput || !fixedProfile.supportedOptions.reasoningEfforts.includes(fixedProfile.reasoningEffort)) throw new ClassificationProviderError("NATIVE_PROFILE_UNSUPPORTED", "not-started");
      // A strategy failure is not a dispatch and must not expose a raw adapter error.
      let encodable: boolean;
      try { encodable = strategy.canEncodeProfile(fixedProfile); }
      catch { throw new ClassificationProviderError("NATIVE_PROFILE_ENCODING_UNAVAILABLE", "not-started"); }
      if (encodable !== true) throw new ClassificationProviderError("NATIVE_PROFILE_UNSUPPORTED", "not-started");
      const input = JSON.stringify(buildVendorMessages(fixedRequest));
      if (Buffer.byteLength(input, "utf8") > fixedProfile.maximumInputBytes) throw new ClassificationProviderError("INPUT_TOO_LONG", "not-started");
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const prepared = await strategy.prepare(fixed, fixedProfile, schema);
        cleanup = prepared.cleanup;
        const args = Object.freeze([...prepared.args]);
        if (signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
        beforeDispatch?.();
        const output = await runner({executable: fixed.executable, args, cwd: fixed.workingDirectory, input, timeoutMs: fixed.timeoutMs, maximumOutputBytes: fixed.maximumOutputBytes}, signal);
        if (signal.aborted) throw new ClassificationProviderError("CANCELLED", "unknown");
        if (Buffer.byteLength(output.stdout, "utf8") > fixed.maximumOutputBytes) throw new ClassificationProviderError("NATIVE_OUTPUT_TOO_LARGE", "unknown");
        if (output.exitCode !== 0) throw new ClassificationProviderError("NATIVE_PROCESS_UNAVAILABLE", "unknown");
        let decoded: ReturnType<NativeCliBehavior["decode"]>;
        try { decoded = strategy.decode(output); }
        catch { throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true); }
        const parsed = responseSchema.safeParse(decoded.response);
        if (!parsed.success || validateClassificationResponse(fixedRequest, parsed.data as SkillClassificationResponseV1).length)
          throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true);
        return {response: parsed.data, dispatchState: "started", diagnostics: null, usage: decoded.usage};
      } catch (error) {
        if (error instanceof ClassificationProviderError) throw error;
        throw new ClassificationProviderError("NATIVE_PROCESS_UNAVAILABLE", "unknown");
      } finally {
        await cleanup?.();
      }
    }});
  }
  return adapters;
}
