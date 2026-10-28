import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { applySkillAdaptation } from "../../scripts/build-claude-plugin.mjs";

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const skillRoot = path.resolve(testsRoot, "..", "..", "skills", "task-contract");
const load = async (name) => JSON.parse(await readFile(path.join(skillRoot, name), "utf8"));

async function taskContractProjection(adaptation) {
  const files = new Map(await Promise.all(["SKILL.md", "references/field-guide.md"].map(async (name) => [
    `skills/task-contract/${name}`, await readFile(path.join(skillRoot, name)),
  ])));
  const shared = new Map(files);
  applySkillAdaptation(files, "task-contract", adaptation);
  return { shared, files };
}

function assertSharedTaskPolicy({ shared, files }) {
  for (const [name, bytes] of shared) assert.equal(files.get(name).toString("utf8"), bytes.toString("utf8"), name);
}

test("Claude task-contract inherits the common trigger and orchestration decision", async () => {
  const adaptation = JSON.parse(await readFile(new URL("../../claude-overlay/adaptations/task-contract.json", import.meta.url), "utf8"));
  const projection = await taskContractProjection(adaptation);
  assertSharedTaskPolicy(projection);
  const guide = projection.files.get("skills/task-contract/references/field-guide.md").toString("utf8");
  assert.match(guide, /\(\.\.\/\.\.\/orchestrator\/references\/entry-details\.md#초기-라우팅\)/u);
  assert.match(guide, /명시적 workflow 요청 여부, 작업 길이나 MCP 연결 여부만으로 정하지 않는다/u);
  assert.match(guide, /필요한 전문 스킬과 권한·검증·독립 감사 조건은 각 적용 범위대로 유지/u);
  assert.match(guide, /계약 작성 요청만 받았다면 이후 workflow를 시작하지 않는다/u);
});

test("projection comparison detects a host-only long-task trigger", async () => {
  const projection = await taskContractProjection({ description: "긴 작업을 나눠 추적해야 할 때 작업 계약을 만든다." });
  assert.throws(() => assertSharedTaskPolicy(projection), { code: "ERR_ASSERTION" });
});

test("projection comparison detects a host-only orchestration decision", async () => {
  const projection = await taskContractProjection({ replacements: [{
    file: "references/field-guide.md", find: "`requested: false`", replace: "`requested: true`",
  }] });
  assert.throws(() => assertSharedTaskPolicy(projection), { code: "ERR_ASSERTION" });
});

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
