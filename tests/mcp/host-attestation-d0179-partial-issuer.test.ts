import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({ write: vi.fn((fd: number, data: unknown) => { void fd; void data; return 0; }) }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), writeSync: diagnostics.write }));

import {
  HOST_ATTESTATION_FIELD,
  hostActorId,
  hostIdentityDigest,
  type HostExecutionAdapter,
} from "../../mcp-server/src/host-attestation.js";
import {
  handleHostAttestationHook,
  probeIssuingMessage,
  type SessionModelRecord,
} from "../../mcp-server/src/host-attestation-hook.js";
import { HOST_SKILL_OBSERVATION_FIELD } from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const SESSION = "d0179-partial-session";
const CALL = "toolu_current_179";
const MODEL = "opaque-issuer-179";
const NOW = new Date("2026-10-25T12:00:00.000Z");
// The fixture supplies an explicit capability, independent of the held catalog/legacy policy.
const adapter: HostExecutionAdapter = {
  host: "claude-code", provider: "synthetic-179", policyRevision: "partial-issuer-fixture",
  modelClassForModel: model => model === MODEL ? "deep" : null,
  resolveModel: (model, provenance = "fixture") => model === MODEL ? {
    host: "claude-code", provider: "synthetic-179", rawModel: model, resolvedModel: model,
    modelClass: "deep", minimumReasoningEffort: "high", supportedEfforts: ["high"],
    aliasUsed: false, policyRevision: "partial-issuer-fixture", provenance,
  } : null,
};

function row(id = CALL): string {
  return JSON.stringify({ type: "assistant", sessionId: SESSION, effort: "high",
    timestamp: new Date(NOW.getTime() - 1000).toISOString(),
    message: { model: MODEL, content: [{ type: "tool_use", id, name: "plan_workflow", input: {} }] } });
}

const issuer = '{"type":"assistant","message":{"model":"opaque-issuer-179","content":[{';
const partials = [
  issuer + '"type":"tool_use"',
  issuer + '"type":"tool_use",',
  issuer + '"type":"tool_use","i',
  issuer + '"type":"tool_use","id"',
  issuer + '"type":"tool_use","id":',
  issuer + '"type":"tool_use","id":"',
  issuer + '"type":"tool_use","id":"toolu_cur',
  issuer + '"id":"toolu_cur',
  issuer + '"type":"tool_u',
  ...[1, 5, CALL.length - 1].map(length => row().slice(0, row().indexOf(CALL) + length)),
  ...[1, 2, 3, 5].map(length => {
    const encoded = row().replace(CALL, "toolu_\\u0063urrent_179");
    return encoded.slice(0, encoded.indexOf("\\u") + length);
  }),
];


const valuePartials = [
  ...["t", "tr", "tru", "f", "fa", "fal", "fals", "n", "nu", "nul",
    "-", "0.", "-0.", "1.", "12.", "1e", "1E", "1e+", "1e-", "-1.25e+", "0.5E-"]
    .map(value => issuer + '"type":"tool_use","input":{"flag":' + value),
  issuer + '"type":"tool_use","input":{"nested":[{"flag":tr',
  issuer + '"type":"tool_use","input":{"flags":[false,nu',
  issuer + '"type":"tool_use","input":{"nested":{"weights":[1,2.5e-',
];
const valueCompletions = [
  [valuePartials[1]!, 'ue},"id":"toolu_current_179","name":"plan_workflow"}]}}'],
  [valuePartials[18]!, '2},"id":"toolu_current_179","name":"plan_workflow"}]}}'],
  [valuePartials[23]!, '2]}},"id":"toolu_current_179","name":"plan_workflow"}]}}'],
] as const;

function fixture() {
  const store = new InMemoryWorkflowStore();
  const key = vi.spyOn(store, "getOrCreateSecret");
  const cache = vi.fn((): SessionModelRecord | null => ({ model: MODEL, source: "session-start",
    observedAt: new Date(NOW.getTime() - 500).toISOString() }));
  const clean = { taskId: "d0179-partial", marker: "private-argument-marker" };
  const input = { hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: CALL,
    transcript_path: "synthetic-only/d0179-partial.jsonl",
    tool_name: "mcp__agent_governance_suite__plan_workflow", effort: { level: "high" },
    tool_input: { ...clean, [HOST_ATTESTATION_FIELD]: "aghs1.caller.forged",
      [HOST_SKILL_OBSERVATION_FIELD]: { forged: true } } };
  return { store, key, cache, clean, input,
    options: { adapter, maxWaitMs: 0, sleep: () => {}, now: () => NOW, readSessionModel: cache } };
}

function updated(output: Record<string, unknown>): Record<string, unknown> {
  return (output.hookSpecificOutput as { updatedInput: Record<string, unknown> }).updatedInput;
}
function payload(output: Record<string, unknown>): Record<string, unknown> {
  const token = updated(output)[HOST_ATTESTATION_FIELD];
  expect(token).toEqual(expect.stringMatching(/^aghs1\.[^.]+\.[^.]+$/u));
  return JSON.parse(Buffer.from(String(token).split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}

beforeEach(() => { diagnostics.write.mockReset(); });

describe("AGS-D-0179 unfinished issuer identity", () => {
  it.each(partials)("does not sign from older/session evidence while issuer identity is incomplete: %s", partial => {
    const f = fixture();
    try {
      expect(probeIssuingMessage(partial, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, readText: () => row("toolu_previous_179") + "\n" + partial });
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: f.clean } });
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).not.toHaveBeenCalled();
      const diagnostic = String(diagnostics.write.mock.calls[0]?.[1]);
      expect(JSON.parse(diagnostic)).toMatchObject({ component: "host-attestation-hook", phase: "fallback", reason: "CURRENT_CALL_INCOMPLETE" });
      for (const privateValue of [SESSION, CALL, MODEL, partial, "private-argument-marker", "aghs1.caller.forged", "synthetic-only"])
        expect(diagnostic).not.toContain(privateValue);
    } finally { f.key.mockRestore(); }
  });

  it.each(valuePartials)("does not confuse an unfinished input value before the ID with issuer absence: %s", partial => {
    const f = fixture();
    let reads = 0;
    try {
      expect(probeIssuingMessage(partial, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10,
        readText: () => { reads++; return row("toolu_previous_179") + "\n" + partial; } });
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: f.clean } });
      expect(reads).toBe(4);
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).not.toHaveBeenCalled();
    } finally { f.key.mockRestore(); }
  });

  it.each(valueCompletions)("accepts an actual exact completion after a partial nested input value: %s", (partial, suffix) => {
    const f = fixture();
    const sleep = vi.fn();
    let reads = 0;
    try {
      const complete = partial + suffix;
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10, sleep,
        readText: () => ++reads === 1 ? partial : complete });
      expect(payload(output)).toMatchObject({ model: MODEL, tool: "plan_workflow", call: hostIdentityDigest(CALL),
        actorId: hostActorId(adapter.host, SESSION), provenance: "claude-code:transcript-tool-use" });
      expect(reads).toBe(2); expect(sleep.mock.calls).toEqual([[10]]);
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).toHaveBeenCalledTimes(1);
      expect(updated(output)[HOST_SKILL_OBSERVATION_FIELD]).toBeUndefined();
      expect((output.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
      expect(diagnostics.write).not.toHaveBeenCalled();
    } finally { f.key.mockRestore(); }
  });

  it.each([
    '{"type":"assistant","unrelated":tr',
    '{"type":"assistant","unrelated":1e-',
    issuer + '"type":"text","input":{"flag":tr',
    '{"type":"user","message":{"content":[{"type":"tool_use","input":{"flag":tr',
    issuer + '"type":"tool_use","id":"toolu_previous_179","input":{"nested":[tr',
    '{"type":"assistant","unrelated":truX',
    '{"type":"assistant","unrelated":01e',
  ])("keeps unrelated partial values or arbitrary unrelated damage eligible for fallback: %s", unrelated => {
    const f = fixture();
    try {
      expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options,
        readText: () => row("toolu_previous_179") + "\n" + unrelated });
      expect(payload(output)).toMatchObject({ model: MODEL, provenance: "claude-code:session-start" });
      expect(f.cache).toHaveBeenCalledTimes(1); expect(f.key).toHaveBeenCalledTimes(1);
    } finally { f.key.mockRestore(); }
  });

  it("keeps the bounded wait, then refuses a persistent partial ID without cache or signing-key access", () => {
    const f = fixture();
    const sleep = vi.fn();
    let reads = 0;
    try {
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10, sleep,
        readText: () => { reads++; return row("toolu_previous_179") + "\n" + partials[6]!; } });
      expect(updated(output)).toEqual(f.clean);
      expect(reads).toBe(4); expect(sleep.mock.calls).toEqual([[10], [10]]);
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).not.toHaveBeenCalled();
    } finally { f.key.mockRestore(); }
  });

  it.each([partials[6]!, partials[13]!])("uses only the actual completed exact row after polling: %s", partial => {
    const f = fixture();
    const sleep = vi.fn();
    let reads = 0;
    try {
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10, sleep,
        readText: () => ++reads === 1 ? partial : row() });
      expect(payload(output)).toMatchObject({ host: adapter.host, model: MODEL, reasoningEffort: "high", tool: "plan_workflow",
        call: hostIdentityDigest(CALL), actorId: hostActorId(adapter.host, SESSION), provenance: "claude-code:transcript-tool-use" });
      expect((output.hookSpecificOutput as Record<string, unknown>).permissionDecision).toBeUndefined();
      expect(updated(output)[HOST_SKILL_OBSERVATION_FIELD]).toBeUndefined();
      expect(reads).toBe(2); expect(sleep.mock.calls).toEqual([[10]]);
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).toHaveBeenCalledTimes(1);
      expect(diagnostics.write).not.toHaveBeenCalled();
    } finally { f.key.mockRestore(); }
  });

  it.each([false, true])("keeps valid exact precedence over an incomplete duplicate in either order: %s", partialFirst => {
    const f = fixture();
    const rows = [row(), partials[6]!];
    if (partialFirst) rows.reverse();
    try {
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, readText: () => rows.join("\n") });
      expect(payload(output)).toMatchObject({ model: MODEL, provenance: "claude-code:transcript-tool-use" });
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).toHaveBeenCalledTimes(1);
    } finally { f.key.mockRestore(); }
  });

  it.each([
    '{"type":"assistant","unrelated":',
    '{"type":"assistant","id":"unrelated"',
    issuer + '"type":"text","text":"toolu_cur',
    '{"type":"user","message":{"content":[{"type":"tool_use","id":"toolu_cur',
    issuer + '"type":"tool_use","id":"other_',
    issuer + '"type":"tool_use","id":"toolu_previous_179","input":{"id":"toolu_cur',
    JSON.stringify({ type: "user", message: { text: "toolu_\\u0063urrent_179" } }).slice(0, -1),
  ])("preserves fallback for distinguishable unrelated damaged rows: %s", unrelated => {
    const f = fixture();
    try {
      expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options,
        readText: () => row("toolu_previous_179") + "\n" + unrelated });
      expect(payload(output)).toMatchObject({ model: MODEL, reasoningEffort: "high", provenance: "claude-code:session-start" });
      expect(f.cache).toHaveBeenCalledTimes(1); expect(f.key).toHaveBeenCalledTimes(1);
    } finally { f.key.mockRestore(); }
  });

  it("keeps a truly absent/ENOENT reader result eligible for interactive session fallback", () => {
    const f = fixture();
    try {
      expect(probeIssuingMessage("", CALL)).toEqual({ state: "absent" });
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, readText: () => null });
      expect(payload(output)).toMatchObject({ model: MODEL, reasoningEffort: "high", provenance: "claude-code:session-start" });
      expect(f.cache).toHaveBeenCalledTimes(1); expect(f.key).toHaveBeenCalledTimes(1);
    } finally { f.key.mockRestore(); }
  });

  it("keeps latest-transcript fallback on true absence without a session model", () => {
    const f = fixture();
    f.cache.mockReturnValue(null);
    try {
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, readText: () => row("toolu_previous_179") });
      expect(payload(output)).toMatchObject({ model: MODEL, reasoningEffort: "high", provenance: "claude-code:transcript-latest" });
      expect(f.cache).toHaveBeenCalledTimes(1); expect(f.key).toHaveBeenCalledTimes(1);
    } finally { f.key.mockRestore(); }
  });

  it("does not resume signing if the incomplete-issuer diagnostic sink throws", () => {
    const f = fixture();
    diagnostics.write.mockImplementationOnce(() => { throw new Error("synthetic sink failure"); });
    try {
      const output = handleHostAttestationHook(f.input, f.store, { ...f.options, readText: () => partials[6]! });
      expect(updated(output)).toEqual(f.clean);
      expect(f.cache).not.toHaveBeenCalled(); expect(f.key).not.toHaveBeenCalled();
    } finally { f.key.mockRestore(); }
  });
});
