import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CallerExecution } from "../../mcp-server/src/caller-identity.js";
import { observeClaudeExecution } from "../../mcp-server/src/host-attestation-hook.js";
import {
  HostAttestationProvider,
  type HostExecutionAdapter,
  type ResolvedModelCapabilityV1,
} from "../../mcp-server/src/host-attestation.js";
import { writeFailureDiagnostic } from "../../mcp-server/src/hook-error-diagnostics.js";
import { createCatalogExecutionAdapters, type ModelRoutingPresetsV1 } from "../../mcp-server/src/host-execution-adapters.js";
import { rootCaller } from "../helpers/caller.js";

const sessionId = "al05-synthetic-session";
const callId = "al05-current-call";
const model = "al05-observed-model";
const adapter: HostExecutionAdapter = {
  host: "al05-synthetic-host",
  provider: "al05-synthetic-provider",
  modelClassForModel: (value) => value === model ? "deep" : null,
};
const clean = { taskId: "al05-task" };
const input = {
  hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: callId,
  transcript_path: "synthetic-only.jsonl", tool_name: "mcp__agent_governance_suite__plan_workflow",
  effort: { level: "high" }, tool_input: clean,
};
const now = () => new Date("2026-10-25T00:01:00.000Z");
const session = (observedAt: string) => ({ model, source: "model-switch" as const, observedAt });
const line = (observedModel = model, timestamp = "2026-10-25T00:00:10.000Z", id = callId) =>
  JSON.stringify({ type: "assistant", sessionId, timestamp, effort: "high",
    message: { model: observedModel, content: [{ type: "tool_use", id, name: "tool", input: {} }] } });
const bootstrap = { phase: "bootstrap" as const, taskId: clean.taskId, runId: null, stageId: null, revision: null };
/** Qualifies one host-observed call against `selected`; returns the rejection, if any. */
function qualify(selected: HostExecutionAdapter, execution: CallerExecution, provider = new HostAttestationProvider(selected)) {
  let failure: unknown;
  let context: unknown;
  try {
    context = provider.run("plan_workflow", rootCaller(selected.host, sessionId, { callId, execution }), () => provider.observe(bootstrap));
  } catch (error) { failure = error; }
  return { failure, context, provider };
}
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// The whole-file limit was removed (a 490 MB session transcript refused every call). Since AGS3-D-0074 only the newest
// 2 MiB window is read, which also bounds memory.
describe("AGS-D-0032 bounded Claude transcript reads", () => {
  const WINDOW_BYTES = 2 * 1024 * 1024;

  it("retains exact observations at the window boundary", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-al05-boundary-"));
    directories.push(directory);
    const file = path.join(directory, "fixture.jsonl");
    const row = line();
    // The issuing row starts right after the newline that opens the window.
    writeFileSync(file, " ".repeat(64) + "\n" + " ".repeat(WINDOW_BYTES - 1 - Buffer.byteLength(row)) + row, "utf8");
    expect(observeClaudeExecution({ ...input, transcript_path: file }, { maxWaitMs: 0, now }))
      .toMatchObject({ model, effort: "high", provenance: "claude-code:transcript-tool-use" });
  });

  it("skips a row cut by the window start before a fallback model is consulted", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-al05-oversize-"));
    directories.push(directory);
    const file = path.join(directory, "fixture.jsonl");
    writeFileSync(file, line() + " ".repeat(WINDOW_BYTES) + "\n", "utf8");
    const cache = vi.fn(() => session("2026-10-25T00:00:20.000Z"));
    expect(observeClaudeExecution({ ...input, transcript_path: file }, { maxWaitMs: 0, now, readSessionModel: cache }))
      .toMatchObject({ model, provenance: "claude-code:model-switch" });
    expect(cache).toHaveBeenCalledTimes(1);
  });
});

// Interactive Claude writes the issuing message while the hook runs: the search reads the file before it lands
// and the later probe sees it. The call is the session's own, so it is observed, not rejected.
it("observes an issuing message written between the search and the probe", () => {
  let reads = 0;
  const readText = () => (++reads === 1 ? "" : line());
  const cache = vi.fn(() => session("2026-10-25T00:00:20.000Z"));
  expect(observeClaudeExecution(input, { maxWaitMs: 0, now, readText, readSessionModel: cache }))
    .toMatchObject({ model, effort: "high", provenance: "claude-code:transcript-tool-use" });
  expect(cache).not.toHaveBeenCalled();
});

it("still rejects a late issuing message from another session", () => {
  let reads = 0;
  const foreign = JSON.stringify({ ...JSON.parse(line()), sessionId: "al05-other-session" });
  const readText = () => (++reads === 1 ? "" : foreign);
  expect(observeClaudeExecution(input, { maxWaitMs: 0, now, readText }))
    .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
});

describe("AGS-D-0033 actual model identity of the call", () => {
  // 3.1.1: an unknown model runs (the catalog never grants execution); it is still the issuing model, never a substitute.
  it("never substitutes a qualified session record for an unknown issuing model", () => {
    const transcript = line(model, "2026-10-25T00:00:10.000Z", "old-call") + "\n" + line("al05-unknown-new-model", "2026-10-25T00:00:30.000Z");
    const cache = vi.fn(() => session("2026-10-25T00:00:40.000Z"));
    const execution = observeClaudeExecution(input, { maxWaitMs: 0, now, readText: () => transcript, readSessionModel: cache });
    expect(execution).toMatchObject({ model: "al05-unknown-new-model", effort: "high" });
    expect(cache).not.toHaveBeenCalled();
    const { failure, context, provider } = qualify(adapter, execution);
    expect(failure).toBeUndefined();
    expect(context).toMatchObject({ model: "al05-unknown-new-model", modelClass: null, reasoningEffort: "high",
      policyNotes: [expect.stringMatching(/^[A-Z_]+$/)] });
    expect(provider.observe({ phase: "bootstrap", taskId: "after-call", runId: null, stageId: null, revision: null })).toBeNull();
  });
});

it("AGS-D-0091 describes only the missing call observation without claiming the adapter is disabled", () => {
  const provider = new HostAttestationProvider(adapter);
  expect(provider.diagnose()).toMatchObject({ host: adapter.host, status: "missing-call-observation",
    connection: expect.stringContaining("did not report the model, reasoning effort or call ID") });
  expect(String(provider.diagnose().connection)).not.toContain("Enable");
});

describe("AGS-D-0091 관측의 현재 정책 거절 원인", () => {
  function fixture(overrides: Partial<ResolvedModelCapabilityV1> = {}) {
    let capability: ResolvedModelCapabilityV1 = {
      host: adapter.host, provider: "d0091-provider", rawModel: model, resolvedModel: model,
      modelClass: "deep", minimumReasoningEffort: "high", supportedEfforts: ["medium", "high"],
      aliasUsed: false, policyRevision: "d0091-r1", provenance: "d0091-host-owned", ...overrides,
    };
    const resolve = vi.fn(() => capability);
    const selected: HostExecutionAdapter = { ...adapter, resolveModel: resolve };
    return { selected, resolve, update: (patch: Partial<ResolvedModelCapabilityV1>) => { capability = { ...capability, ...patch }; } };
  }
  const observed = (effort: "medium" | "high" = "high"): CallerExecution => ({ model, effort, turnId: "d0091-turn", provenance: "d0091-host-owned" });

  it.each([
    { label: "미지원 effort", supportedEfforts: ["high"] as const, reasonCode: "CURRENT_POLICY_EFFORT_UNSUPPORTED" },
    { label: "최소값 미달", supportedEfforts: ["medium", "high"] as const, reasonCode: "CURRENT_POLICY_EFFORT_BELOW_MINIMUM" },
  ])("$label 원인을 현재 정책으로 구분해 기록하고 실행은 막지 않는다", ({ supportedEfforts, reasonCode }) => {
    const f = fixture({ supportedEfforts: [...supportedEfforts] });
    const { failure, context } = qualify(f.selected, observed("medium"));
    expect(failure).toBeUndefined();
    expect(context).toMatchObject({ modelClass: "deep", reasoningEffort: "medium", policyNotes: [reasonCode] });
    expect(f.resolve).toHaveBeenCalledTimes(1);
  });

  it("다른 호스트나 다른 원모델의 기술자를 자격으로 쓰지 않는다", () => {
    const f = fixture();
    f.update({ host: "d0091-other-host" });
    expect(qualify(f.selected, observed()).failure).toMatchObject({ code: "BINDING_INVALID",
      details: { reasonCode: "QUALIFICATION_CAPABILITY_MISMATCH" } });
    f.update({ host: adapter.host, rawModel: "d0091-other-model" });
    expect(qualify(f.selected, observed()).failure).toMatchObject({ code: "BINDING_INVALID",
      details: { reasonCode: "QUALIFICATION_CAPABILITY_MISMATCH" } });
    f.update({ rawModel: model, policyRevision: "" });
    expect(qualify(f.selected, observed()).failure).toMatchObject({ code: "BINDING_INVALID",
      details: { reasonCode: "QUALIFICATION_POLICY_REVISION_MISMATCH" } });
    f.update({ policyRevision: "d0091-r1" });
    expect(qualify(f.selected, observed()).context).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
  });
});

it("AGS3-D-0021 observes the descriptor once without a diagnostic-only capability cache", () => {
  const capability: ResolvedModelCapabilityV1 = {
    host: adapter.host, provider: "al05-provider", rawModel: model, resolvedModel: model,
    modelClass: "deep", minimumReasoningEffort: "high", supportedEfforts: ["high"], aliasUsed: false,
    policyRevision: "al05-r1", provenance: "al05-host-owned",
  };
  const resolve = vi.fn(() => capability);
  const observedAdapter: HostExecutionAdapter = { ...adapter, resolveModel: resolve };
  const { context } = qualify(observedAdapter, { model, effort: "high", turnId: "al05-turn", provenance: "al05-host-owned" });
  expect(context).toMatchObject({ model, modelClass: "deep", reasoningEffort: "high" });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(resolve.mock.results[0]?.value).toBe(capability);
});

// 3.9.0 (AGS3-D-0023): the sink passes only one common-format record line through; other text is replaced.
it("AGS-D-0209 preserves producer serialization and absorbs only diagnostic writer failures", () => {
  const serialized = '{"phase":"fixture","reason":"FIXTURE","component":"fixture","event":"failure"}';
  const writer = vi.fn(() => { throw new Error("synthetic sink unavailable"); });
  expect(() => writeFailureDiagnostic(serialized, writer)).not.toThrow();
  expect(writer).toHaveBeenCalledTimes(1);
  expect(writer).toHaveBeenCalledWith(`${serialized}\n`);
  const other = vi.fn();
  writeFailureDiagnostic('synthetic-prefix {"phase":"fixture","reason":"FIXTURE"}', other);
  expect(other).toHaveBeenCalledWith('{"component":"diagnostics","event":"rejected-record","reason":"NOT_COMMON_FORMAT"}\n');
});

it.each([{ label: "missing", supported: undefined }, { label: "empty", supported: [] as const }])(
  "AGS-D-0089 catalog $label efforts never grant every reasoning effort (recorded, not refused)", ({ supported }) => {
    const presets: ModelRoutingPresetsV1 = {
      schema_version: 1, model_class_order: ["deep"], effort_order: ["high"],
      providers: { synthetic: { host: adapter.host, catalog: { matching: "exact-only", models: {
        [model]: { model_class: "deep", ...(supported === undefined ? {} : { supported_efforts: supported }) },
      } } } },
    };
    const selected = createCatalogExecutionAdapters(presets).adapters.get(adapter.host)!;
    expect(selected.resolveModel!(model)?.supportedEfforts).toEqual([]);
    const { failure, context } = qualify(selected, { model, effort: "high", turnId: "catalog-turn", provenance: "catalog" });
    expect(failure).toBeUndefined();
    expect(context).toMatchObject({ modelClass: "deep", reasoningEffort: "high", policyNotes: ["CURRENT_POLICY_EFFORT_UNSUPPORTED"] });
  },
);
