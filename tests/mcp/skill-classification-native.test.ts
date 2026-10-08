import {EventEmitter} from "node:events";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {PassThrough} from "node:stream";
import type {ChildProcessWithoutNullStreams} from "node:child_process";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createNativeClassificationAdapters, runNativeClassificationCli, resolveNativeClassificationAdapter, type NativeClassificationAdapterDefinition, type NativeCliInvocation, type NativeCliRunner, type NativeCliSpawn} from "../../mcp-server/src/skill-classification/native-adapters.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {ApprovedRouteClassificationProvider} from "../../mcp-server/src/skill-classification/providers.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderProfile} from "../../mcp-server/src/skill-classification/types.js";

const directories: string[] = [];
afterEach(async () => {vi.useRealTimers(); for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});});
async function fixture(host: "codex" | "claude" = "codex") {
  const cwd = await mkdtemp(path.join(tmpdir(), "ags-native-test-")); directories.push(cwd);
  const request = createClassificationRequest({requestId: "req", operationId: "op", originalPrompt: '읽기만 하라. 마지막 수정 금지 "$(malicious)"', inventory: {skills: [], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "t1"}, classificationCriteriaRef: "criteria"});
  const response = {schemaVersion: "1.0.0", requestId: "req", operationId: "op", requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: [], unresolvedItems: [], error: null};
  const profile: ProviderProfile = {profileId: "vendor", providerKind: "vendor", vendorId: "current-vendor", modelId: "fixed-model-2026", modelRevision: "fixed-model-2026", reasoningEffort: "high", supportedOptions: {reasoningEfforts: ["high"], structuredOutput: true}, approvedRouteRef: "approved", qualificationRevision: "fixture-q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: "t1", modelRevision: "fixed-model-2026", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: null, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const definition: NativeClassificationAdapterDefinition = {adapterId: "native-test", host, executable: path.join(cwd, "approved executable.exe"), workingDirectory: cwd, approvalRef: "synthetic-test-approval", capabilityEvidenceRef: "synthetic-capability-proof", retryPolicyVerified: true, retryPolicyEvidenceRef: "synthetic-no-retry-proof", isolationEvidenceRef: "synthetic-isolation-proof", isolationArgs: [], timeoutMs: 100, maximumOutputBytes: 64000};
  const stdout = host === "codex" ? `${JSON.stringify({type: "item.completed", item: {type: "agent_message", text: JSON.stringify(response)}})}\n${JSON.stringify({type: "turn.completed", usage: {input_tokens: 123, output_tokens: 12, cached_input_tokens: 10}})}\n` : JSON.stringify({type: "result", subtype: "success", is_error: false, structured_output: response, total_cost_usd: 0.04, usage: {input_tokens: 123, output_tokens: 12, cache_read_input_tokens: 10, cache_creation_input_tokens: 0}});
  return {cwd, request, response, profile, definition, stdout};
}
function fakeChild() {
  const child = Object.assign(new EventEmitter(), {stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true)}) as unknown as ChildProcessWithoutNullStreams;
  return child;
}
describe("approved native structured classification", () => {
  it.each(["codex", "claude"] as const)("NATIVE01 exact %s profile, schema and bound output without cash/credit fabrication", async host => {
    const f = await fixture(host);
    const runner = vi.fn<NativeCliRunner>(async invocation => {
      expect(invocation.executable).toBe(f.definition.executable);
      expect(invocation.args).not.toContain(f.request.originalPrompt);
      expect(JSON.parse(invocation.input)[1].content).toContain(f.request.originalPrompt.replaceAll('"', '\\"'));
      expect(invocation.args[invocation.args.indexOf("--model") + 1]).toBe("fixed-model-2026");
      if (host === "codex") {
        expect(invocation.args).toContain('model_reasoning_effort="high"');
        expect(invocation.args).toContain("read-only"); expect(invocation.args).toContain("--ignore-user-config");
        const schema = JSON.parse(await readFile(invocation.args[invocation.args.indexOf("--output-schema") + 1]!, "utf8"));
        expect(schema.additionalProperties).toBe(false); expect(schema.required).toContain("requestDigest");
      } else {
        expect(invocation.args[invocation.args.indexOf("--effort") + 1]).toBe("high");
        expect(invocation.args[invocation.args.indexOf("--tools") + 1]).toBe("");
        expect(invocation.args).toContain("--safe-mode"); expect(invocation.args).toContain("--strict-mcp-config");
      }
      return {stdout: f.stdout, exitCode: 0};
    });
    const adapter = createNativeClassificationAdapters([f.definition], runner).get("native-test")!;
    const result = await adapter.invokeStructured(f.request, f.profile, new AbortController().signal);
    expect(result.response).toEqual(f.response); expect(result.usage).toEqual({inputTokens: host === "codex" ? 123 : 133, outputTokens: 12, cachedInputTokens: 10, actualCostUsd: null});
    expect(runner).toHaveBeenCalledTimes(1); expect(await readdir(f.cwd)).toEqual([]);
  });
  it("NATIVE02 evidence absence registers no native route and performs no spawn", async () => {
    const f = await fixture(); const runner = vi.fn<NativeCliRunner>();
    for (const invalid of [{retryPolicyVerified: false}, {retryPolicyEvidenceRef: ""}, {isolationEvidenceRef: ""}, {approvalRef: ""}]) expect(createNativeClassificationAdapters([{...f.definition, ...invalid}], runner).size).toBe(0);
    const registry = createNativeClassificationAdapters([f.definition], runner);
    expect(resolveNativeClassificationAdapter(registry, "native-test", "other", true)).toBeNull(); expect(runner).not.toHaveBeenCalled();
  });
  it("NATIVE03 rejects model/argument injection and oversized input before dispatch", async () => {
    const f = await fixture(); const runner = vi.fn<NativeCliRunner>(); const adapter = createNativeClassificationAdapters([f.definition], runner).get("native-test")!;
    await expect(adapter.invokeStructured(f.request, {...f.profile, modelId: "--premium"}, new AbortController().signal)).rejects.toMatchObject({code: "NATIVE_PROFILE_UNSUPPORTED", dispatchState: "not-started"});
    await expect(adapter.invokeStructured(f.request, {...f.profile, maximumInputBytes: 1}, new AbortController().signal)).rejects.toMatchObject({code: "INPUT_TOO_LONG"});
    expect(() => createNativeClassificationAdapters([{...f.definition, isolationArgs: ["--model", "premium"]}], runner)).toThrow("INVALID_NATIVE_ISOLATION_ARGUMENT");
    expect(runner).not.toHaveBeenCalled(); expect(await readdir(f.cwd)).toEqual([]);
  });
  it.each(["truncated", "wrong-binding", "failed", "extra-message", "tool-use", "too-large"])("NATIVE04 %s never becomes successful no-skill and temp schema is removed", async variant => {
    const f = await fixture(); let stdout = f.stdout;
    if (variant === "truncated") stdout = stdout.slice(0, -5);
    if (variant === "wrong-binding") stdout = stdout.replaceAll(f.request.requestDigest, `sha256:${"b".repeat(64)}`);
    if (variant === "failed") stdout += JSON.stringify({type: "turn.failed", error: {message: "SECRET_SENTINEL"}});
    if (variant === "extra-message") stdout += JSON.stringify({type: "item.completed", item: {type: "agent_message", text: "{}"}});
    if (variant === "tool-use") stdout += JSON.stringify({type: "item.completed", item: {type: "mcp_tool_call"}});
    if (variant === "too-large") stdout = "x".repeat(f.definition.maximumOutputBytes + 1);
    const runner = vi.fn<NativeCliRunner>(async () => ({stdout, exitCode: 0}));
    const adapter = createNativeClassificationAdapters([f.definition], runner).get("native-test")!;
    const error = await adapter.invokeStructured(f.request, f.profile, new AbortController().signal).catch((error: unknown) => error);
    expect(error).toMatchObject({code: variant === "too-large" ? "NATIVE_OUTPUT_TOO_LARGE" : "INVALID_PROVIDER_RESPONSE"});
    expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL"); expect(runner).toHaveBeenCalledTimes(1); expect(await readdir(f.cwd)).toEqual([]);
  });
  it("NATIVE05 Claude free-form result is unsupported; missing usage stays null", async () => {
    const f = await fixture("claude");
    const runner = vi.fn<NativeCliRunner>(async () => ({stdout: JSON.stringify({type: "result", subtype: "success", is_error: false, result: JSON.stringify(f.response)}), exitCode: 0}));
    const adapter = createNativeClassificationAdapters([f.definition], runner).get("native-test")!;
    await expect(adapter.invokeStructured(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE"});
    runner.mockResolvedValue({stdout: JSON.stringify({type: "result", subtype: "success", is_error: false, structured_output: f.response}), exitCode: 0});
    expect((await adapter.invokeStructured(f.request, f.profile, new AbortController().signal)).usage).toEqual({inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: null});
  });
  it("NATIVE06 runner spawn is shell-free and stdin-only; close cleans streams/listeners", async () => {
    const f = await fixture(); const child = fakeChild(); const spawnProcess = vi.fn<NativeCliSpawn>(() => child);
    const invocation: NativeCliInvocation = {executable: f.definition.executable, args: ["--model", "fixed-model"], cwd: f.cwd, input: "public synthetic", timeoutMs: 100, maximumOutputBytes: 100};
    const pending = runNativeClassificationCli(invocation, new AbortController().signal, spawnProcess);
    child.stdout.emit("data", Buffer.from("{}")); child.emit("close", 0);
    expect(await pending).toEqual({stdout: "{}", exitCode: 0});
    expect(spawnProcess.mock.calls[0]?.[2]).toMatchObject({shell: false, windowsHide: true, cwd: f.cwd});
    expect(child.stdout.destroyed).toBe(true); expect(child.stdin.destroyed).toBe(true); expect(child.stdout.listenerCount("data")).toBe(0); expect(child.kill).not.toHaveBeenCalled();
    expect(() => child.stdin.emit("error", new Error("late EPIPE"))).not.toThrow();
  });
  it.each(["abort", "timeout", "buffer", "process-error"])("NATIVE07 %s kills the owned child once and reports uncertain effect without retry", async variant => {
    vi.useFakeTimers(); const child = fakeChild(); const spawnProcess = vi.fn<NativeCliSpawn>(() => child); const controller = new AbortController();
    const pending = runNativeClassificationCli({executable: "approved.exe", args: [], cwd: "private", input: "fixture", timeoutMs: 10, maximumOutputBytes: 10}, controller.signal, spawnProcess).catch((error: unknown) => error);
    if (variant === "abort") controller.abort();
    if (variant === "timeout") await vi.advanceTimersByTimeAsync(10);
    if (variant === "buffer") child.stderr.emit("data", Buffer.from("SECRET_SENTINEL"));
    if (variant === "process-error") child.emit("error", new Error("SECRET_SENTINEL"));
    const error = await pending;
    expect(error).toMatchObject({dispatchState: "unknown", code: variant === "abort" ? "CANCELLED" : variant === "timeout" ? "NATIVE_TIMEOUT" : variant === "buffer" ? "NATIVE_OUTPUT_TOO_LARGE" : "NATIVE_PROCESS_UNAVAILABLE"});
    expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL"); expect(child.kill).toHaveBeenCalledTimes(1); expect(spawnProcess).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it("NATIVE08 pre-abort invokes neither child nor adapter runner", async () => {
    const f = await fixture(); const controller = new AbortController(); controller.abort(); const spawnProcess = vi.fn<NativeCliSpawn>(); const runner = vi.fn<NativeCliRunner>();
    await expect(runNativeClassificationCli({executable: "approved.exe", args: [], cwd: f.cwd, input: "fixture", timeoutMs: 10, maximumOutputBytes: 10}, controller.signal, spawnProcess)).rejects.toMatchObject({dispatchState: "not-started"});
    await expect(createNativeClassificationAdapters([f.definition], runner).get("native-test")!.invokeStructured(f.request, f.profile, controller.signal)).rejects.toMatchObject({code: "CANCELLED"});
    expect(spawnProcess).not.toHaveBeenCalled(); expect(runner).not.toHaveBeenCalled();
  });
  it("NATIVE09 spawn and nonzero exit failures remain sanitized without retry", async () => {
    const f = await fixture(); const spawnProcess = vi.fn<NativeCliSpawn>(() => {throw new Error("SECRET_SENTINEL");});
    const error = await runNativeClassificationCli({executable: "approved.exe", args: [], cwd: f.cwd, input: "fixture", timeoutMs: 10, maximumOutputBytes: 10}, new AbortController().signal, spawnProcess).catch((error: unknown) => error);
    expect(error).toMatchObject({code: "NATIVE_SPAWN_UNAVAILABLE", dispatchState: "not-started"}); expect(JSON.stringify(error)).not.toContain("SECRET_SENTINEL");
    const runner = vi.fn<NativeCliRunner>(async () => ({stdout: "SECRET_SENTINEL", exitCode: 1}));
    await expect(createNativeClassificationAdapters([f.definition], runner).get("native-test")!.invokeStructured(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "NATIVE_PROCESS_UNAVAILABLE", dispatchState: "unknown"});
    expect(runner).toHaveBeenCalledTimes(1); expect(await readdir(f.cwd)).toEqual([]);
  });
  it.each([
    {name: "warm cache", usage: {input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 0}, total: 103, read: 100},
    {name: "cache write", usage: {input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20}, total: 123, read: 100},
    {name: "missing creation", usage: {input_tokens: 3, cache_read_input_tokens: 100}, total: null, read: 100},
    {name: "invalid creation", usage: {input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: -1}, total: null, read: 100},
    {name: "invalid cache read", usage: {input_tokens: 3, cache_read_input_tokens: "invalid", cache_creation_input_tokens: 0}, total: null, read: null},
    {name: "sum overflow", usage: {input_tokens: Number.MAX_SAFE_INTEGER, cache_read_input_tokens: 100, cache_creation_input_tokens: 0}, total: null, read: 100},
  ])("NATIVE10 Claude $name stays successful through service with truthful normalized usage", async ({usage, total, read}) => {
    const f = await fixture("claude");
    const body = JSON.parse(f.stdout); body.usage = {...usage, output_tokens: 12};
    const runner = vi.fn<NativeCliRunner>(async () => ({stdout: JSON.stringify(body), exitCode: 0}));
    const adapter = createNativeClassificationAdapters([f.definition], runner).get("native-test")!;
    const profile = {...f.profile, maximumCostUsd: 0, qualificationRevision: "fixture-native-cash-zero-q2", qualification: {...f.profile.qualification}};
    // Explicitly requalify this intended synthetic cash-zero route variant; actual cash remains unknown.
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    const provider = new ApprovedRouteClassificationProvider([{routeRef: "approved", approvalRef: "fixture-only", approved: true, kind: "native", providerKind: "vendor", vendorId: profile.vendorId, adapterRevision: "a1", modelIds: [profile.modelId], reasoningEfforts: ["high"], structuredOutput: true, invokeStructured: adapter.invokeStructured}]);
    const budget = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {vendor: {approvalRef: "synthetic-native-allowance", remainingCalls: 1}}});
    const result = await new SkillClassificationService({providers: {vendor: provider}, budget}).classify({request: f.request, config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "fixture", externalClassificationAllowed: false, configRevision: "c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "p1", profiles: [profile]}, currentVendorId: profile.vendorId});
    expect(result.response).toEqual(f.response); expect(result.response.status).toBe("SUCCESS");
    expect(result.attempts[0]?.usage).toEqual({inputTokens: total, cachedInputTokens: read, outputTokens: 12, actualCostUsd: null});
    expect(runner).toHaveBeenCalledTimes(1); expect(budget.snapshot().reservations).toHaveLength(1);
  });
});
