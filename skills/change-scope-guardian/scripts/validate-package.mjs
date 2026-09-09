#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "contracts/change-scope-request.v1.schema.json",
  "contracts/workspace-baseline.v1.schema.json",
  "contracts/change-scope-report.v1.schema.json",
  "scripts/validate-report.mjs",
  "tests/behavior-cases.json",
  "integration/skill-descriptor.json",
  "integration/provider-result.v1.schema.json"
];

for (const path of required) readFileSync(join(root, path));
const skill = readFileSync(join(root, "SKILL.md"), "utf8");
if (!skill.startsWith("---\nname: change-scope-guardian\n")) throw new Error("SKILL.md frontmatter name is invalid");
if (/TODO|TBD|TO_BE_CALCULATED/.test(skill)) throw new Error("SKILL.md contains an unfinished placeholder");

for (const file of readdirSync(join(root, "contracts"), { recursive: true })) {
  const full = join(root, "contracts", file);
  if (statSync(full).isFile() && file.endsWith(".json")) JSON.parse(readFileSync(full, "utf8"));
}
for (const file of readdirSync(join(root, "integration"))) {
  if (file.endsWith(".json")) JSON.parse(readFileSync(join(root, "integration", file), "utf8"));
}
const descriptor = JSON.parse(readFileSync(join(root, "integration/skill-descriptor.json"), "utf8"));
if (descriptor.schemaVersion !== "2.0.0") throw new Error("Integration descriptor must use schemaVersion 2.0.0");
const packageMetadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const releaseVersion = readFileSync(join(root, "VERSION"), "utf8").trim();
if (packageMetadata.version !== releaseVersion || descriptor.version !== releaseVersion) {
  throw new Error("VERSION, package.json, and skill descriptor versions must match");
}
for (const provider of descriptor.providers) {
  const targets = provider.inputBindings.map((binding) => binding.targetArtifact);
  if (new Set(targets).size !== targets.length) throw new Error(`Duplicate input binding for ${provider.phase}`);
  for (const artifact of provider.requiredInputArtifacts) {
    if (!targets.includes(artifact)) throw new Error(`Missing input binding for ${provider.phase}:${artifact}`);
  }
  for (const binding of provider.inputBindings) {
    if (!provider.requiredInputArtifacts.includes(binding.targetArtifact)) throw new Error(`Unexpected input binding for ${provider.phase}:${binding.targetArtifact}`);
    if (!Array.isArray(binding.sources) || binding.sources.length === 0) throw new Error(`Input binding sources are missing for ${provider.phase}:${binding.targetArtifact}`);
    if (!["select", "collect", "combine", "require-external"].includes(binding.operation)) throw new Error(`Unknown input binding operation for ${provider.phase}:${binding.targetArtifact}`);
  }
  if (!Array.isArray(provider.stateMapping.adapterErrors)) throw new Error(`Adapter errors must be declared inside stateMapping for ${provider.phase}`);
}
const providerResult = JSON.parse(readFileSync(join(root, "integration/provider-result.v1.schema.json"), "utf8"));
if (!providerResult.$id.includes("/change-scope-guardian/")) throw new Error("ProviderResult schema ID must be skill-specific");
const behavior = JSON.parse(readFileSync(join(root, "tests/behavior-cases.json"), "utf8"));
for (const group of ["normal", "boundary", "failure"]) {
  if (!Array.isArray(behavior[group]) || behavior[group].length === 0) throw new Error(`Behavior fixture group is missing: ${group}`);
}

const upstream = readFileSync(join(root, "contracts/upstream/task-envelope.v1.schema.json"));
const lock = JSON.parse(readFileSync(join(root, "contracts/upstream/lock.json"), "utf8"));
const digest = createHash("sha256").update(upstream).digest("hex");
if (lock.contracts[0].sha256 !== digest) throw new Error("Vendored TaskEnvelope checksum does not match lock.json");
if (!/^[0-9a-f]{40}$/.test(lock.contracts[0].sourceCommit) || lock.contracts[0].sourceRef !== lock.contracts[0].sourceCommit) {
  throw new Error("Vendored TaskEnvelope source must be pinned to a commit SHA");
}

const implementation = readFileSync(join(root, "scripts/lib.mjs"), "utf8");
for (const forbidden of ["reset --hard", "checkout --", "git clean", "git stash", "writeFile", "rmSync", "unlinkSync"]) {
  if (implementation.includes(forbidden)) throw new Error(`Mutation primitive is forbidden: ${forbidden}`);
}
process.stdout.write("package: valid\n");
