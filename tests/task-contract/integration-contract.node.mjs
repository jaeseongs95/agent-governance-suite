import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const skillRoot = path.resolve(testsRoot, "..", "..", "skills", "task-contract");
const load = async (name) => JSON.parse(await readFile(path.join(skillRoot, name), "utf8"));

test("ProviderResult accepts PASS without error and requires error for BLOCKED", async () => {
  const ajv = new Ajv2020({ strict: true });
  for (const name of [
    "contracts/upstream/task-envelope.v1.schema.json",
    "contracts/acceptance-evidence-plan.v1.schema.json",
    "contracts/task-contract-report.v1.schema.json",
  ]) ajv.addSchema(await load(name));
  const validate = ajv.compile(await load("integration/provider-result.v1.schema.json"));
  const fixture = JSON.parse(await readFile(path.join(testsRoot, "fixtures/normal/simple-read.json"), "utf8"));
  const result = { schemaVersion: "1.0.0", kind: "output", output: fixture.report, artifacts: [], error: null };
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  result.output.verdict = "BLOCKED";
  assert.equal(validate(result), false);
  result.error = { code: "MISSING_EVIDENCE", message: "instruction resolution unavailable", details: null };
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
});

test("all public schemas compile under strict Ajv 2020 mode", async () => {
  const ajv = new Ajv2020({ strict: true });
  for (const name of [
    "contracts/upstream/task-envelope.v1.schema.json",
    "contracts/acceptance-evidence-plan.v1.schema.json",
    "contracts/task-contract-request.v1.schema.json",
    "contracts/task-contract-report.v1.schema.json",
  ]) ajv.addSchema(await load(name));
  const validationSchema = await load("contracts/task-contract-validation.v1.schema.json");
  const providerSchema = await load("integration/provider-result.v1.schema.json");
  assert.doesNotThrow(() => ajv.compile(validationSchema));
  assert.doesNotThrow(() => ajv.compile(providerSchema));
});
