import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "mutation-risk-preflight");

async function json(relative) {
  return JSON.parse(await readFile(path.join(skillRoot, relative), "utf8"));
}

test("suite 배포 자산과 descriptor 버전이 일치한다", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const descriptor = await json("integration/skill-descriptor.json");
  const version = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  assert.ok(version);
  assert.ok(descriptor.providers.every((provider) => provider.skillId === "mutation-risk-preflight" && provider.version === version));
});

test("로컬·vendored 공개 JSON Schema를 strict Ajv로 함께 컴파일한다", async () => {
  const schemas = await Promise.all([
    "contracts/mutation-intent.v1.schema.json",
    "contracts/mutation-preflight-report.v1.schema.json",
    "contracts/upstream/task-envelope.v1.schema.json",
    "integration/provider-result.v1.schema.json"
  ].map(json));
  assert.equal(new Set(schemas.map((schema) => schema.$id)).size, schemas.length);
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    formats: {
      "date-time": { type: "string", validate: (value) => Number.isFinite(Date.parse(value)) }
    }
  });
  for (const schema of schemas) assert.doesNotThrow(() => ajv.addSchema(schema));
});

test("v2 descriptor binding과 state mapping이 ProviderResult 오류 계약과 일치한다", async () => {
  const descriptorDocument = await json("integration/skill-descriptor.json");
  const resultSchema = await json("integration/provider-result.v1.schema.json");
  assert.equal(descriptorDocument.schemaVersion, "2.0.0");
  assert.match(resultSchema.$id, /mutation-risk-preflight/);
  const allowedErrors = new Set(resultSchema.$defs.error.properties.code.enum);
  for (const provider of descriptorDocument.providers) {
    const bindings = new Map(provider.inputBindings.map((binding) => [binding.targetArtifact, binding]));
    assert.equal(bindings.size, provider.inputBindings.length);
    for (const artifact of provider.requiredInputArtifacts) {
      assert.ok(bindings.has(artifact), "missing binding for " + artifact);
    }
    for (const binding of provider.inputBindings) {
      assert.ok(binding.sources.length > 0);
      assert.ok(["select", "collect", "combine", "require-external"].includes(binding.operation));
    }
    for (const code of provider.stateMapping.adapterErrors) assert.ok(allowedErrors.has(code), code);
    for (const mapping of Object.values(provider.stateMapping.values)) {
      assert.equal(typeof mapping.errorRequired, "boolean");
      for (const code of mapping.allowedErrorCodes ?? []) assert.ok(allowedErrors.has(code), code);
    }
  }
});

test("TaskEnvelope snapshot lock은 고정 commit과 실제 checksum을 가진다", async () => {
  const lock = await json("contracts/upstream/lock.json");
  const upstream = lock.upstreams[0];
  assert.match(upstream.sourceRef, /^[a-f0-9]{40}$/);
  assert.equal(upstream.sourceCommit, upstream.sourceRef);
  assert.equal(upstream.supplierVersion, "0.2.0");
  const snapshot = await readFile(path.join(skillRoot, upstream.snapshotPath));
  assert.equal(createHash("sha256").update(snapshot).digest("hex"), upstream.sha256);
});
