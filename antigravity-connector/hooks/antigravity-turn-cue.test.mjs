import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const childRuns = vi.hoisted(() => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync(command, args, options) {
    // Observe the real child without changing its argv, stdin, environment or deadline. Only this test captures stderr.
    const observedOptions = options.stdio[2] === "ignore" ? { ...options, stdio: [options.stdio[0], options.stdio[1], "pipe"] } : options;
    const started = performance.now();
    const result = actual.spawnSync(command, args, observedOptions);
    childRuns.push({ command, args, input: options.input, timeoutMs: options.timeout, elapsedMs: performance.now() - started,
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
// The real continuity hook child inherits process.env; keep its stores out of the tester's state.
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

/** A stand-in continuity hook: records its stdin and argv, answers like the UserPromptSubmit cue. */
function fakeContinuityHook(name) {
  const seen = path.join(tmpDir, `${name}.json`), script = path.join(tmpDir, `${name}.mjs`);
  writeFileSync(script, `import { readFileSync, writeFileSync } from "node:fs";
const input = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ input: JSON.parse(input), argv: process.argv.slice(2) }));
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ${JSON.stringify(TURN)} } }));
`);
  return { script, seen: () => JSON.parse(readFileSync(seen, "utf8")) };
}

const noopScript = path.join(tmpDir, "noop.mjs");
writeFileSync(noopScript, "process.stdin.resume(); process.stdin.on(\"end\", () => {});\n");

function options(continuityHookPath) {
  return {
    resolveHostProcess: () => null,
    sessionMessageHook: async () => ({}),
    intakeHook: () => ({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: INTAKE } }),
    sessionBoardHookPath: noopScript,
    ...(continuityHookPath ? { continuityHookPath } : {}),
  };
}

describe("agy turn cue (behavior 6)", () => {
  it("a turn's first model call adds the continuity hook's UserPromptSubmit cue as an ephemeralMessage after the intake pointer", async () => {
    const hook = fakeContinuityHook("first-call");
    const out = await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 0, workspacePaths: [tmpDir] },
      "PreInvocation", "", options(hook.script));
    expect(out).toEqual({ injectSteps: [{ ephemeralMessage: INTAKE }, { ephemeralMessage: TURN }] });
    // Only the session and workspace reach the hook: no prompt text, model fields or agy raw keys.
    expect(hook.seen()).toEqual({ input: { hook_event_name: "UserPromptSubmit", session_id: SESSION, cwd: tmpDir }, argv: ["--host=antigravity"] });
  });

  it("a later model call of the same turn runs neither intake nor the turn cue", async () => {
    const hook = fakeContinuityHook("later-call");
    const out = await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 1, workspacePaths: [tmpDir] },
      "PreInvocation", "", options(hook.script));
    expect(out).toEqual({});
    expect(() => hook.seen()).toThrow();
  });

  it("the built continuity hook gives the AGS turn check naming checkpoint_context and skill re-selection, not the context-continuity skill", async () => {
    const built = fileURLToPath(new URL("../../mcp-server/dist/continuity-hook.mjs", import.meta.url));
    // The built intake hook too: no stand-in, so the context start below is what agy really gets.
    const builtOptions = options(built);
    delete builtOptions.intakeHook;
    const stageDiagnostics = [], started = performance.now();
    const out = await executeAntigravityHookEvent({ conversationId: SESSION, invocationNum: 0, workspacePaths: [tmpDir] },
      "PreInvocation", "", { ...builtOptions, continuityHookPath: built, writeStderr: line => stageDiagnostics.push(line) });
    const trace = JSON.stringify({ out, elapsedMs: performance.now() - started, childRuns, stageDiagnostics });
    expect(out.injectSteps, trace).toHaveLength(2);
    expect(Object.keys(out.injectSteps[0])).toEqual(["ephemeralMessage"]);
    const start = out.injectSteps[0].ephemeralMessage;
    const cue = out.injectSteps[1].ephemeralMessage;
    expect(Object.keys(out.injectSteps[1])).toEqual(["ephemeralMessage"]);
    expect(cue).toContain("[AGS 턴 확인]");
    expect(cue).toContain("checkpoint_context");
    expect(cue).toContain("스킬 선택을 다시 판단");
    expect(cue).not.toContain("context-continuity");
    // AGS3-D-0032 candidate: the built intake hook finds the installed skills next to mcp-server/dist and lists their
    // purposes at the context start (for agy, each turn's first model call); the turn cue points at that list.
    expect(start).toMatch(/references[\\/]intake\.md/u);
    expect(start).toContain("- cs-engineering: concurrency, database, messaging, algorithms, resource-lifetime, performance");
    expect(cue).toContain("맥락 시작에 받은 AGS 스킬별 대상 목록과 대조하고");
    expect(cue).not.toContain("- cs-engineering:");
  });
});
