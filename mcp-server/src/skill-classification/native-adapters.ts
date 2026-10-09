import {spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio} from "node:child_process";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {buildVendorMessages, ClassificationProviderError, unknownUsage} from "./providers.js";
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
  host: "codex" | "claude";
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
export interface NativeCliInvocation {
  executable: string;
  args: readonly string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  maximumOutputBytes: number;
}
export interface NativeCliOutput {stdout: string; exitCode: number | null}
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

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const tokens = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
async function removeNativeSchema(root: string, temporary: string): Promise<void> {
  const target = path.resolve(temporary);
  const relative = path.relative(path.resolve(root), target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ClassificationProviderError("NATIVE_CLEANUP_UNAVAILABLE", "unknown");
  await rm(target, {recursive: true, force: true});
}
function decodeNativeOutput(host: "codex" | "claude", output: NativeCliOutput, request: SkillClassificationRequestV1): ProviderEvaluation {
  if (output.exitCode !== 0) throw new ClassificationProviderError("NATIVE_PROCESS_UNAVAILABLE", "unknown");
  let response: unknown;
  let usage: Record<string, unknown> = {};
  try {
    if (host === "claude") {
      const result: unknown = JSON.parse(output.stdout);
      if (!object(result) || result.type !== "result" || result.subtype !== "success" || result.is_error !== false) throw new Error("NATIVE_RESULT_FAILURE");
      response = result.structured_output;
      if (object(result.usage)) usage = result.usage;
    } else {
      const events: unknown[] = output.stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
      const messages: string[] = [];
      let completed = 0;
      for (const event of events) {
        if (!object(event) || ["error", "turn.failed"].includes(String(event.type))) throw new Error("NATIVE_RESULT_FAILURE");
        if (object(event.item) && ["command_execution", "file_change", "mcp_tool_call", "web_search"].includes(String(event.item.type))) throw new Error("NATIVE_ISOLATION_VIOLATION");
        if (event.type === "item.completed" && object(event.item) && event.item.type === "agent_message") {
          if (typeof event.item.text !== "string") throw new Error("NATIVE_MESSAGE_MISSING");
          messages.push(event.item.text);
        }
        if (event.type === "turn.completed") { completed++; if (object(event.usage)) usage = event.usage; }
      }
      if (completed !== 1 || messages.length !== 1) throw new Error("NATIVE_RESULT_AMBIGUOUS");
      response = JSON.parse(messages[0]!);
    }
  } catch { throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true); }
  const parsed = responseSchema.safeParse(response);
  if (!parsed.success || validateClassificationResponse(request, parsed.data as SkillClassificationResponseV1).length) throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true);
  let inputTokens = tokens(usage.input_tokens);
  if (host === "claude") {
    // Anthropic total input includes uncached + cache read + cache creation. Missing is unknown.
    // https://platform.claude.com/docs/en/build-with-claude/prompt-caching
    const counts = [inputTokens, tokens(usage.cache_read_input_tokens), tokens(usage.cache_creation_input_tokens)];
    inputTokens = counts.every(count => count !== null) ? tokens(counts.reduce<number>((sum, count) => sum + count!, 0)) : null;
  }
  return {response: parsed.data, dispatchState: "started", diagnostics: null, usage: {...unknownUsage(), inputTokens, outputTokens: tokens(usage.output_tokens), cachedInputTokens: tokens(host === "codex" ? usage.cached_input_tokens : usage.cache_read_input_tokens)}};
}

/** Missing retry/isolation evidence registers no route. CLI help is insufficient evidence. */
export function createNativeClassificationAdapters(definitions: readonly NativeClassificationAdapterDefinition[], runner: NativeCliRunner = runNativeClassificationCli): NativeClassificationAdapterRegistry {
  const adapters = new Map<string, NativeClassificationAdapter>();
  const seen = new Set<string>();
  const schema = JSON.stringify(z.toJSONSchema(responseSchema));
  for (const definition of definitions) {
    if (seen.has(definition.adapterId)) throw new Error("DUPLICATE_NATIVE_ADAPTER");
    seen.add(definition.adapterId);
    if (!definition.retryPolicyVerified || !definition.retryPolicyEvidenceRef || !definition.isolationEvidenceRef || !definition.approvalRef || !definition.capabilityEvidenceRef) continue;
    if (!definition.adapterId || !["codex", "claude"].includes(definition.host) || !path.isAbsolute(definition.executable) || /\.(?:cmd|bat|ps1)$/iu.test(definition.executable)
      || !path.isAbsolute(definition.workingDirectory) || !Number.isSafeInteger(definition.timeoutMs) || definition.timeoutMs < 1 || definition.timeoutMs > 300000
      || !Number.isSafeInteger(definition.maximumOutputBytes) || definition.maximumOutputBytes < 1 || definition.maximumOutputBytes > 1024 * 1024
      || !Array.isArray(definition.isolationArgs) || definition.isolationArgs.length > 64 || definition.isolationArgs.some(arg => typeof arg !== "string" || arg.length > 8192 || arg.includes("\0"))) throw new Error("INVALID_NATIVE_ADAPTER_DEFINITION");
    // Extra arguments may only remove discovered capabilities, never override the profile/prompt.
    for (let i = 0; i < definition.isolationArgs.length; i += 2) {
      if (definition.host !== "codex" || definition.isolationArgs[i] !== "--disable" || !/^[A-Za-z0-9_]+$/u.test(definition.isolationArgs[i + 1] ?? "")) throw new Error("INVALID_NATIVE_ISOLATION_ARGUMENT");
    }
    const fixed = structuredClone(definition);
    adapters.set(fixed.adapterId, {capabilityEvidenceRef: fixed.capabilityEvidenceRef, retryPolicy: "no-retry", async invokeStructured(request, profile, signal, beforeDispatch) {
      if (signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
      if (profile.providerKind !== "vendor" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(profile.modelId) || !profile.reasoningEffort
        || !profile.supportedOptions.structuredOutput || !profile.supportedOptions.reasoningEfforts.includes(profile.reasoningEffort)
        || !(fixed.host === "claude" ? ["low", "medium", "high", "xhigh", "max"] : ["low", "medium", "high", "xhigh", "max", "ultra"]).includes(profile.reasoningEffort)) throw new ClassificationProviderError("NATIVE_PROFILE_UNSUPPORTED", "not-started");
      const input = JSON.stringify(buildVendorMessages(request));
      if (Buffer.byteLength(input, "utf8") > profile.maximumInputBytes) throw new ClassificationProviderError("INPUT_TOO_LONG", "not-started");
      let temporary: string | undefined;
      try {
        const args = fixed.host === "claude" ? ["--print", "--safe-mode", "--tools", "", "--strict-mcp-config", "--mcp-config", "{}", "--output-format", "json", "--json-schema", schema, "--model", profile.modelId, "--effort", profile.reasoningEffort, ...fixed.isolationArgs] : ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check", "--model", profile.modelId, "--config", `model_reasoning_effort=${JSON.stringify(profile.reasoningEffort)}`, ...fixed.isolationArgs];
        if (fixed.host === "codex") {
          temporary = await mkdtemp(path.join(fixed.workingDirectory, ".ags-native-"));
          const schemaPath = path.join(temporary, "response.schema.json");
          await writeFile(schemaPath, schema, {encoding: "utf8", flag: "wx", mode: 0o600});
          args.push("--output-schema", schemaPath, "-");
        }
        if (signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
        beforeDispatch?.();
        const output = await runner({executable: fixed.executable, args, cwd: fixed.workingDirectory, input, timeoutMs: fixed.timeoutMs, maximumOutputBytes: fixed.maximumOutputBytes}, signal);
        if (signal.aborted) throw new ClassificationProviderError("CANCELLED", "unknown");
        if (Buffer.byteLength(output.stdout, "utf8") > fixed.maximumOutputBytes) throw new ClassificationProviderError("NATIVE_OUTPUT_TOO_LARGE", "unknown");
        return decodeNativeOutput(fixed.host, output, request);
      } catch (error) {
        if (error instanceof ClassificationProviderError) throw error;
        throw new ClassificationProviderError("NATIVE_PROCESS_UNAVAILABLE", "unknown");
      } finally {
        if (temporary) await removeNativeSchema(fixed.workingDirectory, temporary);
      }
    }});
  }
  return adapters;
}
