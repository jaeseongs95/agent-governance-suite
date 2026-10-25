import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";

const cli = fileURLToPath(new URL("../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs", import.meta.url));
const fixtureUrl = new URL("../mutation-risk-preflight/fixtures/local-delete/intent.json", import.meta.url);
const now = "2026-10-25T00:00:00.000Z";
const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, {recursive: true, force: true}); });
function intent() { return JSON.parse(readFileSync(fixtureUrl, "utf8")); }
function evaluate(input) { return evaluatePreflight(input, {now}); }
function run(argv, input = "") {
  return spawnSync(process.execPath, argv, {input, encoding: "utf8", timeout: 10_000});
}
function expectRuntimeFailure(result, phase) {
  expect(result.error).toBeUndefined(); expect(result.status).toBe(2);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr)).toEqual({component: "mutation-risk-preflight", phase, errorCode: "PREFLIGHT_RUNTIME_ERROR"});
}
function acceptedIrreversible() {
  const input = intent();
  input.recoveryPlan = {available: false, method: null, backupRef: null,
    restoreProcedureRef: null, restoreTestEvidenceRef: null, irreversibilityAccepted: true};
  return input;
}

describe("CG02 / AGS-D-0104 preflight CLI failure identity", () => {
  it.each([
    ["invalid JSON", [], "{"],
    ["empty stdin", [], ""],
    ["missing input argument", ["--input"], ""],
    ["invalid intent schema", [], "{}"],
  ])("keeps %s as an input-validity BLOCKED report", (_name, args, input) => {
    const result = run([cli, ...args], input);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(2); expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout);
    expect(report.verdict).toBe("BLOCKED");
    expect(report.checks[0]).toMatchObject({checkId: "input-validity", state: "failed"});
  });
  it("does not turn an OS read failure into a completed input validation", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-cg02-")); temporary.push(directory);
    expectRuntimeFailure(run([cli, "--input", path.join(directory, "missing-intent.json")]), "input-read");
  });
  it("does not relabel an internal evaluation SyntaxError as malformed input", () => {
    const input = intent(); input.plannedCommandOrTool.tool = "cg02-evaluation-fault";
    // Fault only the evaluator's serialization of this valid intent value, in an isolated child.
    // The real CLI entry, reader, schema validation and evaluator still run; no source rewrite.
    const program = `
      const stringify = JSON.stringify;
      JSON.stringify = (value, ...args) => {
        if (value === "cg02-evaluation-fault") throw new SyntaxError("synthetic evaluation failure");
        return stringify(value, ...args);
      };
      process.argv = [process.execPath, ${JSON.stringify(cli)}];
      await import(${JSON.stringify(pathToFileURL(cli).href)});
    `;
    expectRuntimeFailure(run(["--input-type=module", "--eval", program], JSON.stringify(input)), "evaluation");
  });
  it("preserves a valid ordinary CLI report and success exit code", () => {
    const result = run([cli], JSON.stringify(intent()));
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout).verdict).toBe("READY");
  });
});

describe("CG02 / AGS-D-0135 explicit inherent irreversibility", () => {
  it("accepts unavailable recovery explicitly and truthfully, without imaginary backup or restore", () => {
    const input = acceptedIrreversible(), report = evaluate(input);
    expect(report.verdict).toBe("READY");
    expect(report.classification.reversibility).toBe("irreversible");
    expect(report.recovery).toEqual({available: false, restoreTested: false, irreversibilityAccepted: true, evidenceRefs: []});
    expect(report.checks.find(check => check.checkId === "recovery").state).toBe("passed");
    expect(verifyReceipt({report, intent: input, verificationTime: now}).valid).toBe(true);
    input.recoveryPlan.irreversibilityAccepted = false;
    expect(evaluate(input).verdict).toBe("NEEDS_REDESIGN");
    expect(verifyReceipt({report, intent: input, verificationTime: now})).toMatchObject({valid: false, errorCode: "STALE_REVISION"});
  });
  it.each(["method", "backupRef", "restoreProcedureRef"])("does not waive %s for an available recovery plan", field => {
    const input = intent(); input.recoveryPlan[field] = null; input.recoveryPlan.irreversibilityAccepted = true;
    expect(evaluate(input).verdict).toBe("NEEDS_REDESIGN");
  });
  it("preserves restore-test evidence or explicit irreversibility acceptance for an available plan", () => {
    const input = intent(); expect(evaluate(input).verdict).toBe("READY");
    input.recoveryPlan.restoreTestEvidenceRef = null;
    expect(evaluate(input).verdict).toBe("NEEDS_REDESIGN");
    input.recoveryPlan.irreversibilityAccepted = true;
    expect(evaluate(input).verdict).toBe("READY");
  });
  it.each([
    ["scope", input => { input.scopeRef.excludedTargets.push(input.targets[0].locator); }, "BLOCKED"],
    ["authorization", input => { input.authorizationRef.allowedActions = []; }, "BLOCKED"],
    ["approval", input => { input.approvalEvidenceRefs = []; }, "NEEDS_APPROVAL"],
    ["current-state", input => { input.currentStateEvidenceRefs = []; }, "NEEDS_INPUT"],
    ["blast-radius", input => {
      const locator = "D:/workspace/repo/second.txt";
      input.targets.push({...input.targets[0], locator});
      input.scopeRef.includedTargets.push(locator); input.authorizationRef.allowedTargets.push(locator);
      input.approvalEvidenceRefs[0].targetLocators.push(locator);
      input.currentStateEvidenceRefs.push({...input.currentStateEvidenceRefs[0], targetLocator: locator});
    }, "NEEDS_REDESIGN"],
  ])("does not replace the %s guard with acceptance", (_name, mutate, verdict) => {
    const input = acceptedIrreversible(); mutate(input);
    expect(evaluate(input).verdict).toBe(verdict);
  });
});
