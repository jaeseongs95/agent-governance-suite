import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnostics = vi.hoisted(() => ({ write: vi.fn((fd: number, data: unknown) => { void fd; void data; return 0; }) }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), writeSync: diagnostics.write }));

import type { CallerExecution } from "../../mcp-server/src/caller-identity.js";
import {
  hostActorId,
  HostAttestationProvider,
  type HostExecutionAdapter,
} from "../../mcp-server/src/host-attestation.js";
import {
  observeClaudeExecution,
  probeIssuingMessage,
  type SessionModelRecord,
} from "../../mcp-server/src/host-attestation-hook.js";
import { rootCaller } from "../helpers/caller.js";

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
  const cache = vi.fn((): SessionModelRecord | null => ({ model: MODEL, source: "session-start",
    observedAt: new Date(NOW.getTime() - 500).toISOString() }));
  const input = { hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: CALL,
    transcript_path: "synthetic-only/d0179-partial.jsonl",
    tool_name: "mcp__agent_governance_suite__plan_workflow", effort: { level: "high" },
    tool_input: { taskId: "d0179-partial", marker: "private-argument-marker" } };
  return { cache, input, options: { maxWaitMs: 0, sleep: () => {}, now: () => NOW, readSessionModel: cache } };
}

const incomplete = { unavailable: "CURRENT_CALL_INCOMPLETE" };
/** The server's qualification of the observed execution, with the fixture's explicit capability. */
function qualify(execution: CallerExecution) {
  const provider = new HostAttestationProvider(adapter, () => NOW);
  return provider.run("plan_workflow", rootCaller(adapter.host, SESSION, { callId: CALL, execution }), () =>
    provider.observe({ phase: "bootstrap", taskId: "d0179-partial", runId: null, stageId: null, revision: null }));
}

beforeEach(() => { diagnostics.write.mockReset(); });

describe("AGS-D-0179 unfinished issuer identity", () => {
  it.each([
    issuer + '"type":"tool_use"},{"type":"text","text":"\\q',
    issuer + '"type":"tool_use"},{"type":"tool_result","tool_use_id":"other"},{"type":"tool_use","id":"other"},{"type":"text","text":"\\q',
  ])("does not let later unrelated blocks erase an earlier unidentified issuer: %s", damaged => {
    const f = fixture();
    expect(probeIssuingMessage(damaged, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + damaged });
    expect(output).toEqual(incomplete);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("retains an unidentified issuer after text, tool-result and a complete other ID", () => {
    const f = fixture();
    const damaged = issuer + '"type":"text","text":"earlier"},{"type":"tool_result","tool_use_id":"other"},{"type":"tool_use","id":"other"},{"type":"tool_use","name":"\\q';
    expect(probeIssuingMessage(damaged, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const output = observeClaudeExecution(f.input, { ...f.options, readText: () => damaged });
    expect(output).toEqual(incomplete);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it("keeps absence when every preceding block is clearly unrelated to the current issuer", () => {
    const f = fixture();
    const unrelated = issuer + '"type":"tool_use","id":"other"},{"type":"tool_result","tool_use_id":"other"},{"type":"text","text":"\\q';
    expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + unrelated });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps valid exact precedence over an unidentified earlier content block: %s", damagedFirst => {
    const f = fixture();
    const rows = [row(), issuer + '"type":"tool_use"},{"type":"text","text":"\\q'];
    if (damagedFirst) rows.reverse();
    const output = observeClaudeExecution(f.input, { ...f.options, readText: () => rows.join("\n") });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:transcript-tool-use" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([
    issuer + '"type":"tool_use","name":"\\q',
    issuer + '"type":"tool_use","extra":truX',
    issuer + '"input":{"flag":truX},"type":"tool_use"',
    issuer + '"name":"\\q',
    issuer + '"input":{"flag":truX',
    '{"type":"assistant","extra":truX,"message":{"content":[{"type":"tool_use","name":"\\q',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"earlier"},{"input":{"flag":truX},"type":"tool_use"',
    JSON.stringify({ type: "assistant", message: { content: [{ input: {}, type: "tool_use" }] } }),
  ])("keeps a possible issuer unknown independently of damaged field name or key order: %s", damaged => {
    const f = fixture();
    expect(probeIssuingMessage(damaged, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + damaged });
    expect(output).toEqual(incomplete);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([
    issuer + '"type":"text","name":"\\q',
    issuer + '"type":"tool_result","name":"\\q',
    issuer + '"id":"toolu_previous_179","name":"\\q',
    '{"type":"system","message":{"content":[{"name":"\\q',
    '{"type":"user","extra":truX,"message":{"content":[{"name":"\\q',
    '{"type":"assistant","extra":{"content":[{"name":"\\q',
  ])("retains proved non-issuers and unrelated structure without input-specific assumptions: %s", unrelated => {
    const f = fixture();
    expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + unrelated });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
  });

  it.each([
    issuer + '"type":"tool_use","input":{"flag":truX',
    issuer + '"type":"tool_use","input":{"flag":"\\q',
    issuer + '"type":"tool_use","input":{"flag":"\\u00xz',
    issuer + '"type":"tool_use","input":{"flag":truX},"id":"toolu_cur',
    issuer + '"type":"tool_use","input":{"flag":true]',
    issuer + '"type":"tool_use","input":{"flag":truX}}]}}',
  ])("does not turn unrecoverable issuer input into absent and sign from fallback: %s", damaged => {
    const f = fixture();
    let reads = 0;
    expect(probeIssuingMessage(damaged, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const output = observeClaudeExecution(f.input, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10,
      readText: () => { reads++; return row("toolu_previous_179") + "\n" + damaged; } });
    expect(output).toEqual(incomplete);
    expect(reads).toBe(4); expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([
    '{"type":"assistant","unrelated":truX',
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { flag: true }, id: "toolu_previous_179" }] } }),
    issuer + '"type":"text","input":{"flag":truX',
    '{"type":"user","message":{"content":[{"type":"tool_use","input":{"flag":truX',
    issuer + '"type":"tool_use","id":"toolu_previous_179","input":{"flag":truX',
    issuer + '"type":"tool_use","id":"toolu_previous_179","input":{"flag":"\\q',
  ])("keeps proved non-current or unrelated damage eligible for fallback: %s", unrelated => {
    const f = fixture();
    expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + unrelated });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("keeps actual valid exact precedence over unrecoverable issuer input: %s", damagedFirst => {
    const f = fixture();
    const rows = [row(), issuer + '"type":"tool_use","input":{"flag":truX'];
    if (damagedFirst) rows.reverse();
    const output = observeClaudeExecution(f.input, { ...f.options, readText: () => rows.join("\n") });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:transcript-tool-use" });
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each(partials)("does not sign from older/session evidence while issuer identity is incomplete: %s", partial => {
    const f = fixture();
    expect(probeIssuingMessage(partial, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const output = observeClaudeExecution(f.input, { ...f.options, readText: () => row("toolu_previous_179") + "\n" + partial });
    expect(output).toEqual(incomplete);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each(valuePartials)("does not confuse an unfinished input value before the ID with issuer absence: %s", partial => {
    const f = fixture();
    let reads = 0;
    expect(probeIssuingMessage(partial, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const output = observeClaudeExecution(f.input, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10,
      readText: () => { reads++; return row("toolu_previous_179") + "\n" + partial; } });
    expect(output).toEqual(incomplete);
    expect(reads).toBe(4);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each(valueCompletions)("accepts an actual exact completion after a partial nested input value: %s", (partial, suffix) => {
    const f = fixture();
    const sleep = vi.fn();
    let reads = 0;
    const complete = partial + suffix;
    const output = observeClaudeExecution(f.input, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10, sleep,
      readText: () => ++reads === 1 ? partial : complete });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:transcript-tool-use" });
    expect(qualify(output)).toMatchObject({ model: MODEL, modelClass: "deep", actorId: hostActorId(adapter.host, SESSION) });
    expect(reads).toBe(2); expect(sleep.mock.calls).toEqual([[10]]);
    expect(f.cache).not.toHaveBeenCalled();
    expect(diagnostics.write).not.toHaveBeenCalled();
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
    expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + unrelated });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
  });

  it("keeps the bounded wait, then refuses a persistent partial ID without cache or signing-key access", () => {
    const f = fixture();
    const sleep = vi.fn();
    let reads = 0;
    const output = observeClaudeExecution(f.input, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10, sleep,
      readText: () => { reads++; return row("toolu_previous_179") + "\n" + partials[6]!; } });
    expect(output).toEqual(incomplete);
    expect(reads).toBe(4); expect(sleep.mock.calls).toEqual([[10], [10]]);
    expect(f.cache).not.toHaveBeenCalled();
  });

  it.each([partials[6]!, partials[13]!])("uses only the actual completed exact row after polling: %s", partial => {
    const f = fixture();
    const sleep = vi.fn();
    let reads = 0;
    const output = observeClaudeExecution(f.input, { ...f.options, maxWaitMs: 20, pollIntervalMs: 10, sleep,
      readText: () => ++reads === 1 ? partial : row() });
    expect(output).toMatchObject({ model: MODEL, effort: "high", provenance: "claude-code:transcript-tool-use" });
    expect(qualify(output)).toMatchObject({ model: MODEL, modelClass: "deep", reasoningEffort: "high", actorId: hostActorId(adapter.host, SESSION) });
    expect(reads).toBe(2); expect(sleep.mock.calls).toEqual([[10]]);
    expect(f.cache).not.toHaveBeenCalled();
    expect(diagnostics.write).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps valid exact precedence over an incomplete duplicate in either order: %s", partialFirst => {
    const f = fixture();
    const rows = [row(), partials[6]!];
    if (partialFirst) rows.reverse();
    const output = observeClaudeExecution(f.input, { ...f.options, readText: () => rows.join("\n") });
    expect(output).toMatchObject({ model: MODEL, provenance: "claude-code:transcript-tool-use" });
    expect(f.cache).not.toHaveBeenCalled();
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
    expect(probeIssuingMessage(unrelated, CALL)).toEqual({ state: "absent" });
    const output = observeClaudeExecution(f.input, { ...f.options,
      readText: () => row("toolu_previous_179") + "\n" + unrelated });
    expect(output).toMatchObject({ model: MODEL, effort: "high", provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
  });

  it("keeps a truly absent/ENOENT reader result eligible for interactive session fallback", () => {
    const f = fixture();
    expect(probeIssuingMessage("", CALL)).toEqual({ state: "absent" });
    const output = observeClaudeExecution(f.input, { ...f.options, readText: () => null });
    expect(output).toMatchObject({ model: MODEL, effort: "high", provenance: "claude-code:session-start" });
    expect(f.cache).toHaveBeenCalledTimes(1);
  });

});
