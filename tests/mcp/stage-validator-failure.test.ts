import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { type StageResultV1, WorkflowContractError } from "../../contracts/types.js";
import { assertCsStageBundle } from "../../mcp-server/src/cs-engineering-validator.js";
import { assertEngineeringStageBundle } from "../../mcp-server/src/engineering-practices-validator.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
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

const CS_PROVIDER = "cs-engineering:cs-implementation-review:2";
/** The registry declaration core reads; nothing about the skill's layout is assumed by the validator itself. */
const declared = (root: string, stageValidator?: string) => ({rootDirectory: root,
  read: () => [{providerKey: CS_PROVIDER, ...(stageValidator ? {stageValidator} : {})}] as ReturnType<FileSkillRegistry["read"]>});
const runCs = (root: string, stageValidator?: string) => assertCsStageBundle(declared(root, stageValidator), {providerKey: CS_PROVIDER},
  digest, stageResult("cs-review-bundle", path.join(root, "bundle.json")), validator);

const targets = [
  {name: "CS", emptyReportExitStatus: 3, script: "skills/cs-engineering/scripts/validate.mjs",
    run: (root: string) => runCs(root, "skills/cs-engineering/scripts/validate.mjs")},
  {name: "engineering", emptyReportExitStatus: 1, script: "runtime/engineering-practices/cli.mjs",
    run: (root: string) => assertEngineeringStageBundle(root, digest, "change-code-review", stageResult("engineering-stage-bundle", path.join(root, "bundle.json")), validator)},
];

function caught(run: () => void): WorkflowContractError {
  try { run(); } catch (error) { if (error instanceof WorkflowContractError) return error; throw error; }
  throw new Error("expected WorkflowContractError");
}

describe.each(targets)("$name stage validator process failures keep their cause", ({script, run, emptyReportExitStatus}) => {
  test("missing CLI script reports the exit failure, not bad JSON", () => {
    const root = fakeRoot("unused.mjs", "");
    const error = caught(() => run(root));
    expect(error.code).toBe("GATE_FAILED");
    expect(error.details).toMatchObject({step: "exit"});
    // Child stderr (here a module-not-found trace naming the path) is never copied into public details.
    expect(error.details).not.toHaveProperty("stderr");
    expect(JSON.stringify(error.details)).not.toContain(root);
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
    // A killed validator never judged the files: the server is unavailable (AGS 3.0 error model P1).
    expect(error.code).toBe(process.platform === "win32" ? "GATE_FAILED" : "MCP_UNAVAILABLE");
    expect(error.details).toMatchObject(process.platform === "win32"
      ? {step: "exit", status: 1}
      : {step: "terminated", reason: "VALIDATOR_TERMINATED", signal: "SIGKILL"});
  });

  test("a timed-out validator is reported as a spawn timeout", () => {
    const error = caught(() => run(fakeRoot(script, "setTimeout(() => {}, 12_000);")));
    expect(error.code).toBe("MCP_UNAVAILABLE");
    expect(error.message).not.toContain("bounded JSON");
    expect(error.details).toMatchObject({step: "spawn", reason: "VALIDATOR_SPAWN_FAILED", errno: "ETIMEDOUT"});
  }, 20_000);

  test("a successful exit with non-JSON output is a validator failure, not INVALID_INPUT", () => {
    const error = caught(() => run(fakeRoot(script, "console.log('not json');")));
    expect(error.code).toBe("MCP_UNAVAILABLE");
    expect(error.details).toMatchObject({step: "parse", reason: "VALIDATOR_OUTPUT_INVALID"});
  });
});

describe("AGS3-D-0007 CS stage validator comes from the provider declaration", () => {
  test("CB-13 runs the CLI the stage's provider declares, wherever that skill keeps it", () => {
    const root = fakeRoot("skills/neutral-review/tools/check-bundle.mjs", "process.exitCode = 7;");
    const error = caught(() => runCs(root, "skills/neutral-review/tools/check-bundle.mjs"));
    expect(error.details).toMatchObject({step: "exit", status: 7});
  });

  test("CB-14 an undeclared validator fails closed and never falls back to a skill path core knows", () => {
    const root = fakeRoot("skills/cs-engineering/scripts/validate.mjs", "process.exitCode = 7;");
    const error = caught(() => runCs(root));
    expect(error.code).toBe("MCP_UNAVAILABLE");
    expect(error.details).toEqual({step: "declaration", reason: "STAGE_VALIDATOR_UNDECLARED", providerKey: CS_PROVIDER});
  });

  test("CB-15 the shipped registry declares the CS validator and the registry confines it to the skill folder", () => {
    const repository = path.resolve(import.meta.dirname, "../..");
    const shipped = new FileSkillRegistry(path.join(repository, "skills/registry.json"), validator).read();
    expect(shipped.find(provider => provider.providerKey === CS_PROVIDER)?.stageValidator).toBe("skills/cs-engineering/scripts/validate.mjs");
    const document = JSON.parse(readFileSync(path.join(repository, "skills/registry.json"), "utf8")) as {skills: {skillId: string; providers: Record<string, unknown>[]}[]};
    const skill = document.skills.find(entry => entry.skillId === "cs-engineering")!;
    skill.providers[1]!.stageValidator = "skills/orchestrator/scripts/validate.mjs";
    const root = fakeRoot("skills/registry.json", JSON.stringify({schemaVersion: "2.0.0", skills: [skill]}));
    const error = caught(() => new FileSkillRegistry(path.join(root, "skills/registry.json"), validator).read());
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.details).toMatchObject({skillId: "cs-engineering", schemaPath: "skills/orchestrator/scripts/validate.mjs"});
  });
});
