import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type StageResultV1, WorkflowContractError } from "../../contracts/types.js";
import { assertCsStageBundle } from "../../mcp-server/src/cs-engineering-validator.js";
import { assertEngineeringStageBundle } from "../../mcp-server/src/engineering-practices-validator.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

const digest = `sha256:${"a".repeat(64)}` as const;
const validator = new ContractValidator();
const stageResult = (artifactId: string, locator: string) => ({
  output: {kind: "output", output: {}, artifacts: [{artifactId, locator, digest, verified: true}]},
}) as unknown as StageResultV1;

/** Installs a stand-in CLI so the real validator process failure modes can be produced deterministically. */
function fakeRoot(script: string, body: string) {
  const root = mkdtempSync(path.join(tmpdir(), "ags-stage-failure-")); roots.push(root);
  mkdirSync(path.dirname(path.join(root, script)), {recursive: true});
  writeFileSync(path.join(root, script), body);
  return root;
}

const targets = [
  {name: "CS", emptyReportExitStatus: 3, script: "skills/cs-engineering/scripts/validate.mjs",
    run: (root: string) => assertCsStageBundle(root, digest, stageResult("cs-review-bundle", path.join(root, "bundle.json")), validator)},
  {name: "engineering", emptyReportExitStatus: 1, script: "runtime/engineering-practices/cli.mjs",
    run: (root: string) => assertEngineeringStageBundle(root, digest, "change-code-review", stageResult("engineering-stage-bundle", path.join(root, "bundle.json")), validator)},
];

function caught(run: () => void): WorkflowContractError {
  try { run(); } catch (error) { if (error instanceof WorkflowContractError) return error; throw error; }
  throw new Error("expected WorkflowContractError");
}

describe.each(targets)("$name stage validator process failures keep their cause", ({script, run, emptyReportExitStatus}) => {
  test("missing CLI script reports the exit failure, not bad JSON", () => {
    const error = caught(() => run(fakeRoot("unused.mjs", "")));
    expect(error.code).toBe("GATE_FAILED");
    expect(error.details).toMatchObject({step: "exit"});
  });

  test("non-zero exit with empty stdout is not INVALID_INPUT", () => {
    const error = caught(() => run(fakeRoot(script, "process.exitCode = 5;")));
    expect(error.code).toBe("GATE_FAILED");
    expect(error.message).not.toContain("bounded JSON");
    expect(error.details).toMatchObject({step: "exit", status: 5});
  });

  test("an allowed non-zero exit without JSON is still an exit failure", () => {
    const error = caught(() => run(fakeRoot(script, `process.exitCode = ${emptyReportExitStatus};`)));
    expect(error.code).toBe("GATE_FAILED");
    expect(error.message).not.toContain("bounded JSON");
    expect(error.details).toMatchObject({step: "exit", status: emptyReportExitStatus});
  });

  test("CLI-reported error code and message are preserved", () => {
    const body = "console.error(JSON.stringify({code:'INTEGRITY_FAILED',message:'bundle digest mismatch'})); console.log(JSON.stringify({kind:'adapter-error',error:{code:'INTEGRITY_FAILED',message:'bundle digest mismatch'}})); process.exitCode = 2;";
    const error = caught(() => run(fakeRoot(script, body)));
    expect(error.code).toBe("INTEGRITY_FAILED");
    expect(error.message).toBe("bundle digest mismatch");
    expect(error.details).toMatchObject({step: "exit", status: 2, childCode: "INTEGRITY_FAILED"});
  });

  test("a signal-terminated validator is reported as terminated", () => {
    const error = caught(() => run(fakeRoot(script, "process.kill(process.pid, 'SIGKILL');")));
    expect(error.code).toBe("GATE_FAILED");
    expect(error.details).toMatchObject(process.platform === "win32"
      ? {step: "exit", status: 1}
      : {step: "terminated", signal: "SIGKILL"});
  });

  test("a timed-out validator is reported as a spawn timeout", () => {
    const error = caught(() => run(fakeRoot(script, "setTimeout(() => {}, 12_000);")));
    expect(error.code).toBe("GATE_FAILED");
    expect(error.message).not.toContain("bounded JSON");
    expect(error.details).toMatchObject({step: "spawn", errno: "ETIMEDOUT"});
  }, 20_000);

  test("a successful exit with non-JSON output is still INVALID_INPUT", () => {
    const error = caught(() => run(fakeRoot(script, "console.log('not json');")));
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.details).toMatchObject({step: "parse"});
  });
});
