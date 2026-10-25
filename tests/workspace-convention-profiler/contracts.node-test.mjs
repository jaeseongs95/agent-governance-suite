import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "workspace-convention-profiler");

async function json(relative) {
  return JSON.parse(await readFile(path.join(skillRoot, relative), "utf8"));
}

test("suite 배포 자산과 descriptor 버전이 일치한다", async () => {
  const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  const descriptor = await json("integration/skill-descriptor.json");
  const version = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
  assert.ok(version);
  assert.ok(descriptor.providers.every((provider) => provider.skillId === "workspace-convention-profiler" && provider.version === version));
});

test("모든 공개 JSON Schema를 strict Ajv로 함께 컴파일한다", async () => {
  const schemas = await Promise.all([
    "contracts/workspace-profile-request.v1.schema.json",
    "contracts/workspace-convention-profile.v1.schema.json",
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
  assert.match(resultSchema.$id, /workspace-convention-profiler/);
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

test("validate-skill은 한글·공백·#·%가 있는 설치 경로에서도 실제 파일을 찾아 검증한다", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "설치 경로 #50% "));
  try {
    const installed = path.join(parent, "플러그인 사본", "workspace-convention-profiler");
    await cp(skillRoot, installed, { recursive: true });
    // validate-skill은 독립 배포 형태의 package.json을 요구하므로 SKILL.md 버전과 맞춘 사본을 둔다.
    const version = (await readFile(path.join(skillRoot, "SKILL.md"), "utf8")).match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
    await writeFile(path.join(installed, "package.json"), `${JSON.stringify({ name: "workspace-convention-profiler", version })}\n`);
    const result = spawnSync(process.execPath, [path.join(installed, "scripts", "validate-skill.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { valid: true, errors: [] });
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
