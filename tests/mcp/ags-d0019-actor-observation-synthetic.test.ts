import { describe, expect, it, vi } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput, hostDeliveryProfile, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { actorAccess, isObservedSubagent, type ActorObservation } from "../../mcp-server/src/input-observation.js";

// Synthetic contract cases only. These payloads are not native capture or R7 evidence.
const supportedEvents = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
const input = (event: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event, session_id: "synthetic-session", ...extra,
});
const actor = (host: string, event: string, extra: Record<string, unknown> = {}) => adaptHostInput(input(event, extra), host).observation.actor;

describe("AGS-D-0019 synthetic actor contract", () => {
  it.each([
    ["root", "observed", true], ["root", "inferred", true], ["root", "unavailable", false],
    ["child", "observed", false], ["child", "inferred", false], ["child", "unavailable", false],
    ["indeterminate", "observed", false], ["indeterminate", "inferred", false], ["indeterminate", "unavailable", false],
  ] as const)("decides %s/%s through the shared helper", (role, basis, allowed) => {
    expect(actorAccess({ role, basis, reasonCode: "SYNTHETIC_ROLE_CASE" })).toEqual({ allowed, reasonCode: "SYNTHETIC_ROLE_CASE" });
  });

  it("rejects malformed, legacy, inherited and opaque actor claims without evaluating getters", () => {
    const getter = vi.fn(() => "root");
    const accessor = { get role() { return getter(); }, basis: "observed", reasonCode: "SYNTHETIC_ACCESSOR" };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const candidate of [
      null, undefined, true, 1, "root", [], {},
      { role: "root", basis: "unknown", reasonCode: "SYNTHETIC_UNKNOWN" },
      { role: "root", basis: "observed", reasonCode: "" },
      { role: "root", basis: "observed", reasonCode: "x".repeat(201) },
      { role: "root", basis: "observed", reasonCode: "HAS SPACE" },
      { kind: "main", assurance: "observed", observedBy: "synthetic-legacy" },
      Object.create({ role: "root", basis: "observed", reasonCode: "SYNTHETIC_INHERITED" }),
      accessor, new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("untrusted trap"); } }), revoked.proxy,
    ]) expect(actorAccess(candidate)).toEqual({ allowed: false, reasonCode: "ACTOR_OBSERVATION_INVALID" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("keeps the subagent compatibility helper mapped only to observed children", () => {
    const observation = adaptHostInput(input("PreToolUse", { agent_id: "synthetic-child" }), "claude-code").observation;
    expect(isObservedSubagent(observation)).toBe(true);
    for (const value of [
      { role: "child", basis: "inferred", reasonCode: "SYNTHETIC_CHILD" },
      { role: "root", basis: "observed", reasonCode: "SYNTHETIC_ROOT" },
    ] satisfies ActorObservation[]) expect(isObservedSubagent({ ...observation, actor: value })).toBe(false);
  });

  it("allows a registered synthetic adapter to supply the common contract without vendor fields", () => {
    registerHookHostAdapter("synthetic-d0019", {
      processPid: () => undefined,
      deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
      adaptInput: (_, host) => ({ lifecycle: "none", outputEventName: "synthetic", observation: {
        host, sessionId: "synthetic-session", kind: "user-input", actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_ADAPTER_ROOT" },
      } }),
    });
    expect(actorAccess(adaptHostInput({ agent_id: "must-not-override" }, "synthetic-d0019").observation.actor)).toEqual({
      allowed: true, reasonCode: "SYNTHETIC_ADAPTER_ROOT",
    });
    registerHookHostAdapter("synthetic-d0019-unconfigured", {
      processPid: () => undefined,
      deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
    });
    expect(adaptHostInput({}, "synthetic-d0019-unconfigured").observation.actor).toEqual({
      role: "indeterminate", basis: "unavailable", reasonCode: "HOST_ACTOR_OBSERVATION_UNAVAILABLE",
    });
  });
});

describe("AGS-D-0019 synthetic builtin adapters", () => {
  it.each(supportedEvents)("infers Claude root for supported %s with absent agent_id", event => {
    expect(actor("claude-code", event)).toEqual({ role: "root", basis: "inferred", reasonCode: "CLAUDE_NATIVE_ROOT_AGENT_ID_ABSENT" });
    expect(actor("claude-code", event, { agent_type: "synthetic-agent-type" }).role).toBe("root");
    expect(actor("claude-code", event, { agent_id: "synthetic-child" })).toEqual({
      role: "child", basis: "observed", reasonCode: "CLAUDE_NATIVE_CHILD_AGENT_ID",
    });
  });

  it.each([
    ["UnrecognizedSyntheticEvent", {}, "CLAUDE_NATIVE_EVENT_UNRECOGNIZED"],
    ["PreToolUse", { session_id: " \t" }, "CLAUDE_NATIVE_SESSION_ID_INVALID"],
    ["PreToolUse", { session_id: 42 }, "CLAUDE_NATIVE_SESSION_ID_INVALID"],
    ["PreToolUse", { agent_id: "" }, "CLAUDE_NATIVE_AGENT_ID_INVALID"],
    ["PreToolUse", { agent_id: "  " }, "CLAUDE_NATIVE_AGENT_ID_INVALID"],
    ["PreToolUse", { agent_id: null }, "CLAUDE_NATIVE_AGENT_ID_INVALID"],
    ["PreToolUse", { agent_id: 42 }, "CLAUDE_NATIVE_AGENT_ID_INVALID"],
    ["PreToolUse", { agent_type: "" }, "CLAUDE_NATIVE_AGENT_TYPE_INVALID"],
  ] as const)("keeps invalid Claude %s input indeterminate", (event, extra, reasonCode) => {
    expect(actor("claude-code", event, extra)).toEqual({ role: "indeterminate", basis: "unavailable", reasonCode });
  });

  it.each([...supportedEvents, "UnrecognizedSyntheticEvent"])("requires native capture for Codex %s without lifecycle exceptions", event => {
    for (const extra of [{}, { agent_id: "" }, { agent_id: "synthetic-child" }, { agent_type: "synthetic-root" }, { role: "root", basis: "observed" }]) {
      expect(actor("codex", event, extra)).toEqual({ role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED" });
    }
  });

  it.each([
    ["gemini", "GEMINI_ACTOR_OBSERVATION_UNSUPPORTED"],
    ["antigravity", "ANTIGRAVITY_ACTOR_OBSERVATION_UNSUPPORTED"],
  ] as const)("registers %s with its distinct unsupported reason and existing transport", (host, reasonCode) => {
    for (const event of supportedEvents) expect(actor(host, event, { agent_id: "" })).toEqual({ role: "indeterminate", basis: "unavailable", reasonCode });
    expect(hostDeliveryProfile(host, {}, () => {}, true).transport).toBe("gemini-queue");
    expect(hostDeliveryProfile(host, {}, () => {}, false).transport).toBe("codex-deferred");
  });

  it.each(["codex", "claude-code", "gemini", "antigravity"])("normalizes only nonblank string native call IDs for %s", host => {
    expect(adaptHostInput(input("PreToolUse", { tool_use_id: " synthetic-call " }), host).observation.callId).toBe("synthetic-call");
    for (const tool_use_id of [undefined, null, "", " \t ", 42, {}, []]) {
      expect(adaptHostInput(input("PreToolUse", { tool_use_id, callId: "caller-claim" }), host).observation).not.toHaveProperty("callId");
    }
  });
});
