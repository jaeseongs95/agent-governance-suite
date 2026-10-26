import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLAUDE_TRANSCRIPT_MAX_BYTES,
  findLatestAssistantObservation,
  handleHostAttestationHook,
  handleRegisteredHostAttestationHook,
  registerHookAttestationStrategy,
} from "../../mcp-server/src/host-attestation-hook.js";
import {
  HOST_ATTESTATION_FIELD,
  HostAttestationProvider,
  hostActorId,
  issueHostAttestation,
  type HostExecutionAdapter,
  type ResolvedModelCapabilityV1,
} from "../../mcp-server/src/host-attestation.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { writeFailureDiagnostic } from "../../mcp-server/src/hook-error-diagnostics.js";
import { createCatalogExecutionAdapters, type ModelRoutingPresetsV1 } from "../../mcp-server/src/host-execution-adapters.js";

const sessionId = "al05-synthetic-session";
const callId = "al05-current-call";
const model = "al05-observed-model";
const adapter: HostExecutionAdapter = {
  host: "al05-synthetic-host",
  modelClassForModel: (value) => value === model ? "deep" : null,
};
const clean = { taskId: "al05-task" };
const input = {
  hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: callId,
  transcript_path: "synthetic-only.jsonl", tool_name: "mcp__agent_governance_suite__plan_workflow",
  effort: { level: "high" }, tool_input: { ...clean,
    [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged", _hostSkillObservation: { sourceRef: "caller" } },
};
const now = () => new Date("2026-10-25T00:01:00.000Z");
const session = (observedAt: string) => ({ model, source: "model-switch" as const, observedAt });
const line = (observedModel = model, timestamp = "2026-10-25T00:00:10.000Z", id = callId) =>
  JSON.stringify({ type: "assistant", sessionId, timestamp, effort: "high",
    message: { model: observedModel, content: [{ type: "tool_use", id, name: "tool", input: {} }] } });
const updated = (output: Record<string, unknown>) =>
  (output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("AGS-D-0022 dispatches only explicitly registered strategies and never borrows a builtin for unknown IDs", () => {
  const openStore = vi.fn(() => new InMemoryWorkflowStore());
  const context = { databasePath: "synthetic-only.sqlite3", openStore };
  expect(handleRegisteredHostAttestationHook("al05-unregistered-strategy", input, context))
    .toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: clean } });
  expect(openStore).not.toHaveBeenCalled();
  const observe = vi.fn(() => ({ systemMessage: "synthetic strategy dispatched" }));
  registerHookAttestationStrategy("al05-explicit-strategy", { observe });
  expect(handleRegisteredHostAttestationHook("al05-explicit-strategy", input, context))
    .toEqual({ systemMessage: "synthetic strategy dispatched" });
  expect(observe).toHaveBeenCalledWith(input, context);
  expect(openStore).not.toHaveBeenCalled();
  expect(() => registerHookAttestationStrategy("al05-explicit-strategy", { observe }))
    .toThrow("DUPLICATE_HOOK_ATTESTATION_STRATEGY");
});

describe("AGS-D-0032 bounded Claude transcript reads", () => {
  it("retains exact observations at the byte boundary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-al05-boundary-"));
    directories.push(directory);
    const file = path.join(directory, "fixture.jsonl");
    const row = line();
    writeFileSync(file, " ".repeat(CLAUDE_TRANSCRIPT_MAX_BYTES - Buffer.byteLength(row)) + row, "utf8");
    const output = handleHostAttestationHook({ ...input, transcript_path: file }, new InMemoryWorkflowStore(),
      { adapter, maxWaitMs: 0, now });
    expect(updated(output)).toEqual({ ...clean, [HOST_ATTESTATION_FIELD]: expect.any(String) });
  });

  it("refuses oversized history before a signing key or fallback model is consulted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-al05-oversize-"));
    directories.push(directory);
    const file = path.join(directory, "fixture.jsonl");
    writeFileSync(file, line(), "utf8");
    truncateSync(file, CLAUDE_TRANSCRIPT_MAX_BYTES + 1);
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    const cache = vi.fn(() => session("2026-10-25T00:00:20.000Z"));
    expect(() => handleHostAttestationHook({ ...input, transcript_path: file }, store,
      { adapter, maxWaitMs: 0, now, readSessionModel: cache })).toThrow("TRANSCRIPT_LIMIT_EXCEEDED");
    expect(key).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
  });
});

describe("AGS-D-0033 latest actual model identity", () => {
  const transcript = line(model, "2026-10-25T00:00:10.000Z", "old-call") + "\n"
    + line("al05-unknown-new-model", "2026-10-25T00:00:30.000Z", "newer-call");

  it("never substitutes an older qualified model or older session record for an unknown latest model", () => {
    expect(findLatestAssistantObservation(transcript, sessionId, null, now().getTime(), adapter))
      .toEqual({ model: "al05-unknown-new-model", at: Date.parse("2026-10-25T00:00:30.000Z") });
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    const output = handleHostAttestationHook(input, store, { adapter, maxWaitMs: 0, now,
      readText: () => transcript, readSessionModel: () => session("2026-10-25T00:00:20.000Z") });
    const signed = updated(output);
    expect(signed).toEqual({...clean, [HOST_ATTESTATION_FIELD]: expect.stringMatching(/^aghs2\.[^.]+\.[^.]+$/u)});
    const token = String(signed[HOST_ATTESTATION_FIELD]);
    expect(JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")))
      .toMatchObject({v: 2, model: "al05-unknown-new-model", reasoningEffort: "high", eligibility: null});
    expect(key).toHaveBeenCalled();
    const provider = new HostAttestationProvider(store, adapter);
    let failure: unknown;
    try {
      provider.run("plan_workflow", signed, () =>
        provider.observe({phase: "bootstrap", taskId: clean.taskId, runId: null, stageId: null, revision: null}));
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({code: "BINDING_INVALID",
      message: "Host observation has no matching trusted execution capability and policy revision."});
    expect(provider.lastObservedCapability()).toBeNull();
  });

  it("keeps a genuinely newer session model and the synthetic-placeholder control", () => {
    const options = { adapter, maxWaitMs: 0, now, readText: () => transcript,
      readSessionModel: () => session("2026-10-25T00:00:40.000Z") };
    expect(updated(handleHostAttestationHook(input, new InMemoryWorkflowStore(), options))[HOST_ATTESTATION_FIELD])
      .toEqual(expect.any(String));
    const placeholders = line(model, "2026-10-25T00:00:10.000Z", "old-call") + "\n"
      + line("<synthetic>", "2026-10-25T00:00:30.000Z", "placeholder-call");
    expect(findLatestAssistantObservation(placeholders, sessionId, null, now().getTime(), adapter)?.model).toBe(model);
  });
});

it("AGS-D-0091 describes only the observed missing signed call without claiming the adapter is disabled", () => {
  const provider = new HostAttestationProvider(new InMemoryWorkflowStore(), adapter);
  expect(provider.diagnose()).toMatchObject({ host: adapter.host, status: "missing-call-observation",
    connection: expect.stringContaining("no signed host observation") });
  expect(String(provider.diagnose().connection)).not.toContain("Enable");
});

it("AGS-D-0185 reuses the capability that was verified instead of resolving it again for diagnostics", () => {
  const capability: ResolvedModelCapabilityV1 = {
    host: adapter.host, provider: "al05-provider", rawModel: model, resolvedModel: model,
    modelClass: "deep", minimumReasoningEffort: "high", supportedEfforts: ["high"], aliasUsed: false,
    policyRevision: "al05-r1", provenance: "al05-host-owned",
  };
  const resolve = vi.fn(() => capability);
  const observedAdapter: HostExecutionAdapter = { ...adapter, resolveModel: resolve };
  const store = new InMemoryWorkflowStore();
  const token = issueHostAttestation(store, observedAdapter, { tool: "plan_workflow", input: clean,
    model, reasoningEffort: "high", actorId: hostActorId(adapter.host, sessionId), sessionId,
    turnId: "al05-turn", toolUseId: callId });
  expect(token).toEqual(expect.any(String));
  resolve.mockClear();
  const provider = new HostAttestationProvider(store, observedAdapter);
  const context = provider.run("plan_workflow", { ...clean, [HOST_ATTESTATION_FIELD]: token }, () =>
    provider.observe({ phase: "bootstrap", taskId: clean.taskId, runId: null, stageId: null, revision: null }));
  expect(context).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(provider.lastObservedCapability()).toBe(capability);
});

it("AGS-D-0209 preserves producer serialization and absorbs only diagnostic writer failures", () => {
  const serialized = 'synthetic-prefix {"phase":"fixture","reason":"FIXTURE"}';
  const writer = vi.fn(() => { throw new Error("synthetic sink unavailable"); });
  expect(() => writeFailureDiagnostic(serialized, writer)).not.toThrow();
  expect(writer).toHaveBeenCalledTimes(1);
  expect(writer).toHaveBeenCalledWith(serialized);
});

it.each([{ label: "missing", supported: undefined }, { label: "empty", supported: [] as const }])(
  "AGS-D-0089 catalog $label efforts never grant every reasoning effort", ({ supported }) => {
    const presets: ModelRoutingPresetsV1 = {
      schema_version: 1, model_class_order: ["deep"], effort_order: ["high"],
      providers: { synthetic: { host: adapter.host, catalog: { matching: "exact-only", models: {
        [model]: { model_class: "deep", ...(supported === undefined ? {} : { supported_efforts: supported }) },
      } } } },
    };
    const selected = createCatalogExecutionAdapters(presets).adapters.get(adapter.host)!;
    expect(selected.resolveModel!(model)?.supportedEfforts).toEqual([]);
    const store = new InMemoryWorkflowStore();
    const key = vi.spyOn(store, "getOrCreateSecret");
    const token = issueHostAttestation(store, selected, { tool: "plan_workflow", input: clean, model,
      reasoningEffort: "high", actorId: hostActorId(adapter.host, sessionId), sessionId,
      turnId: "catalog-turn", toolUseId: "catalog-call" });
    expect(token).toEqual(expect.stringMatching(/^aghs2\.[^.]+\.[^.]+$/u));
    expect(JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8")))
      .toMatchObject({v: 2, model, reasoningEffort: "high", eligibility: null});
    expect(key).toHaveBeenCalled();
    const provider = new HostAttestationProvider(store, selected);
    let failure: unknown;
    try {
      provider.run("plan_workflow", {...clean, [HOST_ATTESTATION_FIELD]: token}, () =>
        provider.observe({phase: "bootstrap", taskId: clean.taskId, runId: null, stageId: null, revision: null}));
    } catch (error) { failure = error; }
    expect(failure).toMatchObject({code: "BINDING_INVALID",
      message: "Host observation has no matching trusted execution capability and policy revision."});
    expect(provider.lastObservedCapability()).toBeNull();
  },
);
