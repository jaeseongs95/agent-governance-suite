import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixture = async (name) => JSON.parse(await readFile(path.join(root, "tests/task-contract/fixtures", name), "utf8"));
function cli(input) {
  const result = spawnSync(process.execPath, [path.join(root, "skills/task-contract/scripts/validate-task-contract.mjs")], {
    input: JSON.stringify(input), encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.stderr, "");
  return { status: result.status, ...JSON.parse(result.stdout) };
}

test("CLI accepts project-authorized development without asking again and retains explicit approvals", async () => {
  const input = await fixture("normal/project-development.json");
  const result = cli(input);
  assert.equal(result.status, 0, JSON.stringify(result.error));
  assert.equal(result.output.verdict, "PASS");
  assert.deepEqual(result.output.taskEnvelope.authorization, input.report.taskEnvelope.authorization);
});

test("CLI rejects unbound or relabeled project grants and provenance receipts", async () => {
  for (const sourceLocator of ["user-request", "artifact://instruction-scope-resolution/not-supplied"]) {
    const input = await fixture("normal/project-development.json");
    input.request.authorizationEvidence[0].sourceLocator = sourceLocator;
    input.report.authorizationProvenance[0].sourceLocator = sourceLocator;
    const result = cli(input);
    assert.equal(result.status, 1);
    assert.match(result.error.message, /instruction resolution reference/u);
  }
  const receipt = await fixture("normal/project-development.json");
  receipt.request.authorizationEvidence[0].sourceReceiptId = "source-abcdefghijklmnop";
  receipt.report.authorizationProvenance[0].sourceReceiptId = "source-abcdefghijklmnop";
  assert.match(cli(receipt).error.message, /cannot authorize an action/u);
});

test("CLI preserves reasonable request inference without accepting missing authority or conflicts", async () => {
  const input = await fixture("normal/simple-read.json");
  assert.equal(input.report.provenance.find(item => item.field === "/authorization").basis, "verified-inference");
  assert.equal(cli(input).status, 0);

  input.request.authorizationEvidence.shift();
  assert.match(cli(input).error.message, /request authority record/u);

  const conflict = await fixture("normal/project-development.json");
  const action = conflict.report.taskEnvelope.authorization.approvalRequired.shift();
  conflict.report.taskEnvelope.authorization.allowedActions.push(action);
  conflict.report.authorizationProvenance.find(item => item.action === action).envelopeField = "/authorization/allowedActions";
  conflict.report.authorizationProvenance.find(item => item.action === action).effect = "allow";
  conflict.request.authorizationEvidence.push({action, effect: "allow", authority: "project-instruction", sourceLocator: conflict.request.instructionResolutionRefs[0]});
  assert.match(cli(conflict).error.message, /cannot be omitted/u);
});
