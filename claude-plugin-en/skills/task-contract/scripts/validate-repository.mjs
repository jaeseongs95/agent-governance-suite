#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

import { validateTaskContract } from "./validate-task-contract.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "references/field-guide.md",
  "references/risk-and-authorization-rubric.md",
  "references/acceptance-criteria.md",
  "contracts/upstream/task-envelope.v1.schema.json",
  "contracts/upstream/lock.json",
  "contracts/task-contract-request.v1.schema.json",
  "contracts/task-contract-report.v1.schema.json",
  "contracts/acceptance-evidence-plan.v1.schema.json",
  "integration/skill-descriptor.json",
  "integration/provider-result.v1.schema.json",
  "tests/behavior-cases.json",
];
for (const filename of required) await access(path.join(root, filename));

const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
if (!skill.startsWith("---\nname: task-contract\n")) throw new Error("SKILL.md frontmatter name mismatch");
if (/TODO|PLACEHOLDER|example resource/iu.test(skill)) throw new Error("SKILL.md contains scaffold placeholders");
for (const link of ["references/field-guide.md", "references/risk-and-authorization-rubric.md", "references/acceptance-criteria.md"]) {
  if (!skill.includes(link)) throw new Error(`SKILL.md does not link ${link}`);
}
const openai = await readFile(path.join(root, "agents/openai.yaml"), "utf8");
if (!openai.includes("$task-contract") || !openai.includes("allow_implicit_invocation: true")) {
  throw new Error("agents/openai.yaml invocation metadata mismatch");
}
const cases = JSON.parse(await readFile(path.join(root, "tests/behavior-cases.json"), "utf8"));
for (const group of ["normal", "boundary", "failure"]) {
  if (!Array.isArray(cases[group]) || cases[group].length === 0) throw new Error(`behavior fixture group is empty: ${group}`);
}

const snapshotPath = path.join(root, "contracts/upstream/task-envelope.v1.schema.json");
const snapshot = await readFile(snapshotPath);
const snapshotJson = JSON.parse(snapshot.toString("utf8"));
const lock = JSON.parse(await readFile(path.join(root, "contracts/upstream/lock.json"), "utf8"));
const digest = createHash("sha256").update(snapshot).digest("hex");
if (lock.artifacts?.[0]?.sha256 !== digest) throw new Error("upstream TaskEnvelope checksum does not match lock.json");
if (lock.artifacts[0].schemaId !== snapshotJson.$id) throw new Error("upstream TaskEnvelope $id does not match lock.json");
if (!/^v\d+\.\d+\.\d+$/u.test(lock.supplier?.ref ?? "") || !/^[a-f0-9]{40}$/u.test(lock.supplier?.commit ?? "")) {
  throw new Error("upstream TaskEnvelope lock must include an immutable ref and commit SHA");
}

const descriptor = JSON.parse(await readFile(path.join(root, "integration/skill-descriptor.json"), "utf8"));
if (descriptor.schemaVersion !== "2.0.0" || descriptor.skillId !== "task-contract") throw new Error("descriptor identity mismatch");
if (descriptor.priority !== 50 || descriptor.providers?.[0]?.executionClass !== "bootstrap") {
  throw new Error("descriptor integration defaults mismatch");
}
const provider = descriptor.providers[0];
if (!provider.inputBindings.every((binding) => binding.targetArtifact && Array.isArray(binding.sources) && binding.sources.length > 0)) {
  throw new Error("descriptor v2 input binding mismatch");
}
if (!Array.isArray(provider.stateMapping.adapterErrors) || "adapterErrors" in provider) {
  throw new Error("descriptor adapterErrors must be inside stateMapping");
}

const ajv = new Ajv2020({ strict: true });
for (const filename of [
  "contracts/upstream/task-envelope.v1.schema.json",
  "contracts/acceptance-evidence-plan.v1.schema.json",
  "contracts/task-contract-report.v1.schema.json",
]) {
  ajv.addSchema(JSON.parse(await readFile(path.join(root, filename), "utf8")));
}
const providerSchema = JSON.parse(await readFile(path.join(root, "integration/provider-result.v1.schema.json"), "utf8"));
if (providerSchema.$id !== "https://agent-governance-skills.local/task-contract/integration/provider-result.v1.schema.json") {
  throw new Error("provider-result schema ID is not skill-specific");
}
ajv.compile(providerSchema);

const fixture = JSON.parse(await readFile(path.join(root, "tests/fixtures/normal/simple-read.json"), "utf8"));
await validateTaskContract(fixture);
console.log("task-contract repository is valid");
