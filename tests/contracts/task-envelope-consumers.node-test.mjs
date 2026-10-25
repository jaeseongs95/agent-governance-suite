import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { assertTaskEnvelope } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";
import { assertSchema } from "../../skills/change-scope-guardian/scripts/schema-validator.mjs";
import { validateTaskContract } from "../../skills/task-contract/scripts/validate-task-contract.mjs";

const fixture = JSON.parse(await readFile(new URL("../task-contract/fixtures/normal/simple-read.json", import.meta.url), "utf8"));
const artifactContracts = [{ capability: "fixture-capability", produced: [{
  artifactId: "fixture-report", schemaId: "fixture/v1", targetDigest: "sha256:" + "a".repeat(64),
}] }];
const consumers = {
  acceptance: (task) => assertTaskEnvelope(task),
  "change-scope": (task) => assertSchema("taskEnvelope", task),
  "task-contract": (task) => validateTaskContract({ ...structuredClone(fixture), report: { ...structuredClone(fixture.report), taskEnvelope: task } }),
};
for (const [name, consume] of Object.entries(consumers)) {
  test(name + " consumes the current shared optional artifact contract", async () => {
    await consume({ ...structuredClone(fixture.report.taskEnvelope), artifactContracts: structuredClone(artifactContracts) });
  });
  test(name + " rejects malformed artifact targets", async () => {
    const task = { ...structuredClone(fixture.report.taskEnvelope), artifactContracts: structuredClone(artifactContracts) };
    task.artifactContracts[0].produced[0].targetDigest = "not-a-digest";
    await assert.rejects(async () => consume(task));
  });
  test(name + " still rejects unknown root fields", async () => {
    await assert.rejects(async () => consume({ ...structuredClone(fixture.report.taskEnvelope), undeclaredField: true }));
  });
}
