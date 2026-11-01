import os from "node:os";
import { expect, it } from "vitest";
import { executeAntigravityHookEvent } from "./antigravity-hook-runner.mjs";

// AGS 3.0 error model P6 (D-0181 residual): a failed Antigravity stage keeps its fail-open/deny decision but leaves
// one bounded stderr line with the stage and the error's own code, never the message.
const failure = () => Object.assign(new Error("PRIVATE /secret/path"), { code: "EACCES" });
const parse = lines => lines.map(line => JSON.parse(line.slice(line.indexOf("{"))));

it("records each failed advisory stage and still fails open", async () => {
  const lines = [];
  const output = await executeAntigravityHookEvent({ conversationId: "stage-failure-session", workspacePaths: [os.tmpdir()] }, "PreInvocation", "", {
    stageRunner: async () => { throw failure(); },
    writeStderr: line => lines.push(line),
  });
  expect(output).toEqual({});
  expect(lines.every(line => line.startsWith("[agent-governance-suite] antigravity-stage-failure "))).toBe(true);
  // PreInvocation runs only the session-message stage: the 3.0 board removed every agy board stage
  // (docs/ags30-session-board-design.md, D7: agy has no prompt observation for the board hook).
  expect(parse(lines)).toEqual([{ stage: "session-message", code: "EACCES" }]);
  expect(lines.join("")).not.toContain("PRIVATE");
});

it("records a failed host-attestation stage and keeps the fail-closed deny", async () => {
  const lines = [];
  const output = await executeAntigravityHookEvent({ conversationId: "stage-failure-session", workspacePaths: [os.tmpdir()],
    toolCall: { name: "run_command", arguments: { CommandLine: "echo fixture" } } }, "PreToolUse", "host-attestation", {
    stageRunner: async () => { throw failure(); },
    writeStderr: line => lines.push(line),
  });
  expect(output).toMatchObject({ decision: "deny" });
  expect(parse(lines)).toEqual([{ stage: "host-attestation", code: "EACCES" }]);
});
