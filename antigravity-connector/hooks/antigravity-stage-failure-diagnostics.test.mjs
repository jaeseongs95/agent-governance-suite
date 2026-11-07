import os from "node:os";
import { expect, it } from "vitest";
import { executeAntigravityHookEvent } from "./antigravity-hook-runner.mjs";

// AGS 3.0 error model P6 (D-0181 residual): a failed Antigravity stage keeps its fail-open/deny decision but leaves
// one bounded stderr line with the stage and the error's own code, never the message.
const failure = () => Object.assign(new Error("PRIVATE /secret/path"), { code: "EACCES" });
// AGS3-D-0023: each line is exactly one common record; the envelope is checked, the payload compared.
const parse = lines => lines.map(line => {
  expect(line).toMatch(/^\{[^\r\n]*\}\n$/u);
  const { component, event, ...payload } = JSON.parse(line);
  expect([component, event]).toEqual(["antigravity-hook-runner", "stage-failure"]);
  return payload;
});

it("records each failed advisory stage and still fails open", async () => {
  const lines = [];
  const output = await executeAntigravityHookEvent({ conversationId: "stage-failure-session", workspacePaths: [os.tmpdir()] }, "PreInvocation", "", {
    stageRunner: async () => { throw failure(); },
    writeStderr: line => lines.push(line),
    // The record-only board hook is outside this advisory-stage fixture; never launch it against shared state.
    spawnSync: () => ({ status: 0 }),
  });
  expect(output).toEqual({});
  // Only the injected session-message stage fails; the separate board record succeeds above.
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
