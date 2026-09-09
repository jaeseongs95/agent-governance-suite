import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills", "instruction-scope-resolver");
const load = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));

test("ProviderResult requires structured errors for BLOCKED and adapter errors", async () => {
  const ajv = new Ajv2020({ strict: true });
  ajv.addSchema(await load("contracts/instruction-scope-resolution.v1.schema.json"));
  const validate = ajv.compile(await load("integration/provider-result.v1.schema.json"));
  const blockedOutput = {
    schemaVersion: "1.0.0",
    workspaceRoot: "C:\\workspace",
    instructionFileManifest: [],
    targets: [{ requestedPath: "src", resolvedPath: "C:\\workspace\\src", exists: true, instructionChain: [], activeRules: [], overriddenRules: [], unresolvedConflicts: [] }],
    findings: ["instruction evidence unavailable"],
    analysisStatus: "complete",
    verdict: "BLOCKED",
  };
  const result = { schemaVersion: "1.0.0", kind: "output", output: blockedOutput, artifacts: [], error: null };
  assert.equal(validate(result), false);
  result.error = { code: "MISSING_EVIDENCE", message: "instruction evidence unavailable", details: null };
  assert.equal(validate(result), true, JSON.stringify(validate.errors));
  assert.equal(validate({ schemaVersion: "1.0.0", kind: "adapter-error", output: null, artifacts: [], error: result.error }), true);
});

test("strict schemas reject a premature PASS with incomplete semantic analysis", async () => {
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile(await load("contracts/instruction-scope-resolution.v1.schema.json"));
  const output = {
    schemaVersion: "1.0.0",
    workspaceRoot: "C:\\workspace",
    instructionFileManifest: [],
    targets: [{ requestedPath: "src", resolvedPath: "C:\\workspace\\src", exists: true, instructionChain: [], activeRules: [], overriddenRules: [], unresolvedConflicts: [] }],
    findings: [],
    analysisStatus: "required",
    verdict: "PASS"
  };
  assert.equal(validate(output), false);
});
