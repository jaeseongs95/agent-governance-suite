import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { builtinCallerIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { antigravityCallKey } from "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput, hookExecutionObserver } from "../../mcp-server/src/host-input-adapter.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// AGS3-D-0068. Oracle: agy 1.5.3 Linux capture (tests/real-host/binding-capture/agy-subagent-hook-capture.mjs): a
// subagent's hook input names only its own conversation (conversationId), while its tools/call `_meta` names the root
// and the direct parent. Claude Code and Codex hooks give a subagent the root session plus its own agent ID; the agy
// adapter has to give the same once the server has seen the root.
const S = "agy-root-conversation";
const A = "agy-child-a";
const B = "agy-grandchild-b";
const meta = (conversation: string, root = conversation, parent?: string) => ({
  "antigravity.google/conversation_id": conversation, "antigravity.google/root_conversation_id": root,
  ...(parent === undefined ? {} : { "antigravity.google/parent_conversation_id": parent }), progressToken: 1,
});
/** What the agy runner hands the shared hooks at a turn start (the "turn" stage) and at a tool boundary. */
const turnStart = (conversation: string) => ({ hook_event_name: "UserPromptSubmit", session_id: conversation });
const sessionStart = (conversation: string) => ({ hook_event_name: "SessionStart", session_id: conversation, source: "startup" });
const args = { schemaVersion: "1.0.0", goal: "하위 작업" };
const preToolUse = (conversation: string) => ({ hook_event_name: "PreToolUse", session_id: conversation, model: "gemini-4-argon-high",
  tool_name: "mcp__agent-governance-suite__start_workflow", tool_input: args });

let directory = "";
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-d0068-"));
  vi.stubEnv("AGENT_GOVERNANCE_DB_PATH", path.join(directory, "workflows.sqlite3"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

function serverCall(store: InMemoryWorkflowStore, callMeta: Record<string, unknown>, tool = "list_session_status", callArgs: unknown = {}) {
  const result = builtinCallerIngress("antigravity", store)!(tool, callMeta, callArgs);
  if (result.provenance !== "host-observed") throw new Error(`unobserved: ${result.reason}`);
  return result.caller;
}

describe("AGS3-D-0068 agy subagent hooks inherit the root session", () => {
  it("keeps a subagent's hooks on its own conversation until its first AGS call, then names the root and the child", () => {
    const store = new InMemoryWorkflowStore();
    expect(adaptHostInput(turnStart(A), "antigravity").observation).toMatchObject({ sessionId: A, actor: { role: "root", basis: "inferred" } });

    const caller = serverCall(store, meta(A, S, S));
    const { observation } = adaptHostInput(turnStart(A), "antigravity");
    // The same root session and agent key the server gives this subagent's own calls.
    expect(caller).toMatchObject({ sessionId: S, actor: { role: "child" } });
    expect(observation).toMatchObject({ sessionId: S, agentKey: A, actor: { role: "child", basis: "observed" }, kind: "subagent-start" });
  });

  it("gives a nested subagent the root, not its direct parent", () => {
    const store = new InMemoryWorkflowStore();
    serverCall(store, meta(B, S, A));
    expect(adaptHostInput(turnStart(B), "antigravity").observation).toMatchObject({ sessionId: S, agentKey: B, actor: { role: "child" } });
  });

  it("leaves the root conversation's own hooks as the root and records nothing for it", () => {
    const store = new InMemoryWorkflowStore();
    serverCall(store, meta(S));
    const adapted = adaptHostInput(turnStart(S), "antigravity");
    expect(adapted.observation).toMatchObject({ sessionId: S, kind: "user-input", actor: { role: "root", basis: "inferred" } });
    expect(adapted.observation.agentKey).toBeUndefined();
    expect(adapted.restoreCurrentAtTurnStart).toBe(true);
    expect(readdirSync(directory)).not.toContain("antigravity-conversation-roots");
  });

  it("keeps a resolved subagent's session start a context start (the intake pointer) without making it the root", () => {
    const store = new InMemoryWorkflowStore();
    serverCall(store, meta(A, S, S));
    const adapted = adaptHostInput(sessionStart(A), "antigravity");
    expect(adapted.lifecycle).toBe("start");
    expect(adapted.observation).toMatchObject({ sessionId: S, agentKey: A, actor: { role: "child" } });
  });

  it("still lets the server claim the subagent hook's model row, keyed by the subagent's own conversation", () => {
    const store = new InMemoryWorkflowStore();
    serverCall(store, meta(A, S, S));
    const input = preToolUse(A);
    const { observation } = adaptHostInput(input, "antigravity");
    expect(observation.sessionId).toBe(S);
    expect(observation.callId!.startsWith(`${antigravityCallKey(A, "start_workflow", args).call}:`)).toBe(true);
    store.recordCallAdmission({ host: "antigravity", callId: observation.callId!, tool: "start_workflow", sessionId: observation.sessionId,
      agentId: null, execution: hookExecutionObserver("antigravity")!(input, {}), transcriptPath: null });
    expect(serverCall(store, meta(A, S, S), "start_workflow", args)).toMatchObject({
      sessionId: S, execution: { model: "gemini-4-argon", effort: "high" } });
  });

  it("reports a record that is not this conversation's instead of treating the subagent as a root", () => {
    const roots = path.join(directory, "antigravity-conversation-roots");
    mkdirSync(roots, { recursive: true });
    const file = `${createHash("sha256").update(A, "utf8").digest("hex").slice(0, 32)}.json`;
    writeFileSync(path.join(roots, file), JSON.stringify({ conversation: "someone-else", root: S }));
    expect(() => adaptHostInput(turnStart(A), "antigravity")).toThrow(expect.objectContaining({ code: "ANTIGRAVITY_CONVERSATION_ROOT_INVALID" }));
  });
});
