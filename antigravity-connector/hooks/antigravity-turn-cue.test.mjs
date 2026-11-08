import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const childRuns = vi.hoisted(() => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync(command, args, options) {
    // Observe the real child without changing its argv, stdin, environment or deadline. Only this test captures stderr.
    const observedOptions = options?.stdio?.[2] === "ignore" ? { ...options, stdio: [options.stdio[0], options.stdio[1], "pipe"] } : options;
    const started = performance.now();
    const result = actual.spawnSync(command, args, observedOptions);
    childRuns.push({ command, args, input: options?.input, timeoutMs: options?.timeout, elapsedMs: performance.now() - started,
      status: result.status, signal: result.signal, error: result.error ? { code: result.error.code, message: result.error.message } : null,
      stdout: result.stdout, stderr: result.stderr });
    return result;
  } };
});
beforeEach(() => { childRuns.length = 0; });

import { executeAntigravityHookEvent } from "./antigravity-hook-runner.mjs";

// Behavior 6 (d7585d74): agy has no prompt-submit event, so a turn's first model call (PreInvocation invocationNum 0)
// runs session-message, intake and turn. The turn stage feeds the continuity hook a UserPromptSubmit input and adds its
// cue as an ephemeralMessage, like the intake pointer, so it does not pile up in the trajectory.
const SESSION = "00000000-0000-4000-8000-0000000060e1";
const tmpDir = mkdtempSync(path.join(os.tmpdir(), "ags-agy-turn-cue-"));
// The real continuity hook reads process.env; keep its stores out of the tester's state.
for (const [key, value] of Object.entries({
  AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(tmpDir, "shared"),
  AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(tmpDir, "session-board.sqlite3"),
  AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(tmpDir, "session-messaging"),
  AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(tmpDir, "trust.sqlite3"),
  AGENT_GOVERNANCE_DB_PATH: path.join(tmpDir, "workflows.sqlite3"),
  AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(tmpDir, "continuity.sqlite3"),
  AGENT_GOVERNANCE_LOCALE: "ko",
})) process.env[key] = value;
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

const INTAKE = "AGS-INTAKE-POINTER-60e1";
const TURN = "AGS-TURN-CUE-60e1";

/** A stand-in continuity hook entry: records its input and host, answers like the UserPromptSubmit cue. */
function fakeContinuityHook() {
  const calls = [];
  const hook = (raw, _environment, host) => {
    calls.push({ input: JSON.parse(raw), host });
    return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: TURN } });
  };
  return { hook, calls };
}

function options(continuityHook) {
  return {
    resolveHostProcess: () => null,
    sessionMessageHook: async () => ({}),
    intakeHook: () => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: INTAKE } }),
    sessionBoardHook: async () => "",
    ...(continuityHook ? { continuityHook } : {}),
  };
}

/** Children started with a shared hook bundle; the bundles run in the runner's own process (AGS3-D-0079). */
const bundleChildren = () => childRuns.filter(run => run.args?.some(arg => /mcp-server[\\/]dist[\\/][^\\/]+\.mjs$/u.test(String(arg))));

describe("agy turn cue (behavior 6)", () => {
  it("a turn's first model call adds the continuity hook's UserPromptSubmit cue as an ephemeralMessage after the intake pointer", async () => {
    const hook = fakeContinuityHook();
    const out = await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 0, workspacePaths: [tmpDir] },
      "PreInvocation", "", options(hook.hook));
    expect(out).toEqual({ injectSteps: [{ ephemeralMessage: INTAKE }, { ephemeralMessage: TURN }] });
    // Only the session and workspace reach the hook: no prompt text, model fields or agy raw keys.
    expect(hook.calls).toEqual([{ input: { hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: tmpDir }, host: "antigravity" }]);
  });

  it("a later model call of the same turn runs neither intake nor the turn cue", async () => {
    const hook = fakeContinuityHook();
    const out = await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 1, workspacePaths: [tmpDir] },
      "PreInvocation", "", options(hook.hook));
    expect(out).toEqual({});
    expect(hook.calls).toEqual([]);
  });

  it("the built continuity hook gives the AGS turn check naming checkpoint_context and skill re-selection, not the context-continuity skill", async () => {
    // The built continuity and intake hooks: no stand-in, so the context start below is what agy really gets.
    const builtOptions = options();
    delete builtOptions.intakeHook;
    const stageDiagnostics = [], started = performance.now();
    const out = await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 0, workspacePaths: [tmpDir] },
      "PreInvocation", "", { ...builtOptions, writeStderr: line => stageDiagnostics.push(line) });
    const trace = JSON.stringify({ out, elapsedMs: performance.now() - started, childRuns, stageDiagnostics });
    expect(out.injectSteps, trace).toHaveLength(2);
    expect(Object.keys(out.injectSteps[0])).toEqual(["ephemeralMessage"]);
    const start = out.injectSteps[0].ephemeralMessage;
    const cue = out.injectSteps[1].ephemeralMessage;
    expect(Object.keys(out.injectSteps[1])).toEqual(["ephemeralMessage"]);
    // Hook text is rendered in the model locale (en, locales/en/hooks.json), although the host locale above is ko.
    expect(cue).toContain("[AGS turn check]");
    expect(cue).toContain("checkpoint_context");
    // 4.0.0 (token optimization): the save line names the trigger and re-selection for it.
    expect(cue).toContain("re-select skills for it, then checkpoint_context");
    expect(cue).not.toContain("context-continuity");
    // AGS3-D-0032 candidate: the built intake hook finds the installed skills next to mcp-server/dist and lists their
    // purposes at the context start (for agy, each turn's first model call); the turn cue points at that list.
    expect(start).toMatch(/references[\\/]intake\.md/u);
    expect(start).toContain("- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance");
    expect(cue).toContain("against the skill targets and call each match");
    expect(cue).not.toContain("- cs-engineering:");
    // AGS3-D-0079: the built bundle ran in this process, not as a second node process.
    expect(bundleChildren(), trace).toEqual([]);
    expect(stageDiagnostics, trace).toEqual([]);
  });

  it("the continuity step after a model call runs the built bundle in the runner's own process", async () => {
    const stageDiagnostics = [];
    await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 2, workspacePaths: [tmpDir] },
      "PostInvocation", "continuity", { ...options(), writeStderr: line => stageDiagnostics.push(line) });
    expect(bundleChildren()).toEqual([]);
    expect(stageDiagnostics).toEqual([]);
  });
});
