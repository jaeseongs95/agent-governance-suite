#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "contracts/instruction-scope-request.v1.schema.json",
  "contracts/instruction-scope-resolution.v1.schema.json",
  "integration/skill-descriptor.json",
  "integration/provider-result.v1.schema.json",
  "references/resolution-model.md",
  "references/conflict-classification.md",
  "tests/behavior-cases.json",
];
for (const filename of required) await access(path.join(root, filename));

const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
if (!skill.startsWith("---\nname: instruction-scope-resolver\n")) throw new Error("SKILL.md frontmatter name mismatch");
if (/TODO|PLACEHOLDER|example resource/iu.test(skill)) throw new Error("SKILL.md contains scaffold placeholders");
for (const link of ["references/resolution-model.md", "references/conflict-classification.md"]) {
  if (!skill.includes(link)) throw new Error(`SKILL.md does not link ${link}`);
}
const openai = await readFile(path.join(root, "agents/openai.yaml"), "utf8");
if (!openai.includes("$instruction-scope-resolver") || !openai.includes("allow_implicit_invocation: true")) {
  throw new Error("agents/openai.yaml invocation metadata mismatch");
}
const cases = JSON.parse(await readFile(path.join(root, "tests/behavior-cases.json"), "utf8"));
for (const group of ["normal", "boundary", "failure"]) {
  if (!Array.isArray(cases[group]) || cases[group].length === 0) throw new Error(`behavior fixture group is empty: ${group}`);
}

const ajv = new Ajv2020({ strict: true });
for (const filename of [
  "contracts/instruction-scope-request.v1.schema.json",
  "contracts/instruction-scope-resolution.v1.schema.json",
]) {
  ajv.addSchema(JSON.parse(await readFile(path.join(root, filename), "utf8")));
}
ajv.compile(JSON.parse(await readFile(path.join(root, "integration/provider-result.v1.schema.json"), "utf8")));
const descriptor = JSON.parse(await readFile(path.join(root, "integration/skill-descriptor.json"), "utf8"));
if (descriptor.schemaVersion !== "2.0.0" || descriptor.skillId !== "instruction-scope-resolver") throw new Error("descriptor identity mismatch");
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
const providerSchema = JSON.parse(await readFile(path.join(root, "integration/provider-result.v1.schema.json"), "utf8"));
if (providerSchema.$id !== "https://agent-governance-skills.local/instruction-scope-resolver/integration/provider-result.v1.schema.json") {
  throw new Error("provider-result schema ID is not skill-specific");
}
console.log("instruction-scope-resolver repository is valid");
