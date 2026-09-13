import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { ROOT, computeDirectoryChecksum, readJson, walkFiles } from "./lib.mjs";
import { validateSkill } from "./validate-skill.mjs";

const requiredFiles = [
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  ".mcp.json",
  "skills/registry.json",
  "skills/source-lock.json",
  "mcp-server/dist/server.mjs",
  "runtime/schema-validation.mjs",
  "runtime/THIRD_PARTY_NOTICES.md",
  "pnpm-lock.yaml"
];
const errors = [];

for (const relativePath of requiredFiles) {
  try {
    await access(path.join(ROOT, relativePath));
  } catch {
    errors.push(`missing required file: ${relativePath}`);
  }
}

if (errors.length === 0) {
  const plugin = await readJson(path.join(ROOT, ".codex-plugin", "plugin.json"));
  if (plugin.name !== "agent-governance-suite" || !/^\d+\.\d+\.\d+$/u.test(plugin.version ?? "")) {
    errors.push("plugin name/version must be agent-governance-suite with a strict semantic version");
  }
  const packageDocument = await readJson(path.join(ROOT, "package.json"));
  if (packageDocument.name !== plugin.name || packageDocument.version !== plugin.version) {
    errors.push("package.json name/version must match the plugin manifest");
  }
  const pluginInfoSource = await readFile(path.join(ROOT, "mcp-server", "src", "plugin-info.ts"), "utf8");
  if (!pluginInfoSource.includes(`id: "${plugin.name}"`) || !pluginInfoSource.includes(`version: "${plugin.version}"`)) {
    errors.push("MCP plugin info name/version must match the plugin manifest");
  }
  if (!pluginInfoSource.includes(`repository: "${plugin.repository}"`)) {
    errors.push("MCP plugin info repository must match the plugin manifest");
  }
  for (const manifestPath of [plugin.skills, plugin.mcpServers]) {
    if (typeof manifestPath !== "string" || !manifestPath.startsWith("./")) {
      errors.push("plugin skills and mcpServers must use relative ./ paths");
      continue;
    }
    try {
      await access(path.join(ROOT, manifestPath));
    } catch {
      errors.push(`plugin manifest path does not exist: ${manifestPath}`);
    }
  }

  const registryDocument = await readJson(path.join(ROOT, "skills", "registry.json"));
  const registryCandidate = Array.isArray(registryDocument) ? registryDocument : registryDocument.skills;
  if (!Array.isArray(registryCandidate)) errors.push("skills/registry.json must contain a skills array");
  const registry = Array.isArray(registryCandidate) ? registryCandidate : [];
  if (registryDocument.schemaVersion !== "2.0.0") errors.push("skills/registry.json must use schemaVersion 2.0.0");
  const ids = new Set();
  for (const descriptor of registry) {
    if (ids.has(descriptor.skillId)) errors.push(`duplicate skill id: ${descriptor.skillId}`);
    ids.add(descriptor.skillId);
    if (descriptor.path !== `./${descriptor.skillId}`) {
      errors.push(`registry path for ${descriptor.skillId} must be ./${descriptor.skillId}`);
    }
    try {
      await access(path.join(ROOT, "skills", descriptor.skillId, "SKILL.md"));
    } catch {
      errors.push(`registry skill path does not exist: skills/${descriptor.skillId}/SKILL.md`);
    }
  }

  const descriptorSchema = await readJson(path.join(ROOT, "contracts", "skill-descriptor.v2.schema.json"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const validateDescriptor = ajv.compile(descriptorSchema);
  for (const descriptor of registry) {
    if (!validateDescriptor(descriptor)) {
      errors.push(`invalid registry descriptor ${descriptor.skillId}: ${ajv.errorsText(validateDescriptor.errors)}`);
    }
  }

  const sourceLock = await readJson(path.join(ROOT, "skills", "source-lock.json"));
  if (sourceLock.schemaVersion !== "1.0.0" || !Array.isArray(sourceLock.sources)) {
    errors.push("skills/source-lock.json must be a v1 sources document");
  } else {
    const sourceIds = new Set();
    for (const source of sourceLock.sources) {
      if (sourceIds.has(source.skillId)) errors.push(`duplicate source lock id: ${source.skillId}`);
      sourceIds.add(source.skillId);
      if (!ids.has(source.skillId)) errors.push(`source lock references unknown skill: ${source.skillId}`);
      if (source.path !== `skills/${source.skillId}`) errors.push(`invalid source lock path for ${source.skillId}`);
      if (!/^[a-f0-9]{40}$/u.test(source.commit ?? "")) errors.push(`invalid source commit for ${source.skillId}`);
      if (!/^sha256:[a-f0-9]{64}$/u.test(source.checksum ?? "")) errors.push(`invalid source checksum for ${source.skillId}`);
      try {
        const actualChecksum = await computeDirectoryChecksum(path.join(ROOT, source.path));
        if (actualChecksum !== source.checksum) {
          errors.push(`source checksum mismatch for ${source.skillId}`);
        }
      } catch (error) {
        errors.push(`cannot verify source checksum for ${source.skillId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const marketplace = await readJson(path.join(ROOT, ".agents", "plugins", "marketplace.json"));
  const marketplaceEntry = marketplace.plugins?.find((entry) => entry.name === plugin.name);
  if (marketplace.name !== "agent-governance" || !marketplaceEntry) {
    errors.push("marketplace must expose agent-governance-suite from agent-governance");
  } else if (marketplaceEntry.source?.source !== "url" || marketplaceEntry.source?.ref !== `v${plugin.version}`) {
    errors.push(`marketplace source must pin the GitHub root plugin at v${plugin.version}`);
  }

  const skillDirectories = (await readdir(path.join(ROOT, "skills"), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of skillDirectories) {
    errors.push(...(await validateSkill(name)).map((error) => `${name}: ${error}`));
  }

  const capabilityOwners = new Map();
  for (const descriptor of registry) {
    for (const provider of descriptor.providers ?? []) {
      for (const capability of provider.capabilities ?? []) {
        const owners = capabilityOwners.get(capability) ?? [];
        owners.push({ descriptor, provider });
        capabilityOwners.set(capability, owners);
      }
    }
  }
  for (const [capability, owners] of capabilityOwners) {
    if (owners.length > 1) {
      const priorities = new Set(owners.map((owner) => owner.descriptor.priority));
      if (priorities.size !== owners.length || owners.some((owner) => !Array.isArray(owner.provider.selectionCriteria) || owner.provider.selectionCriteria.length === 0)) {
        errors.push(`overlapping capability ${capability} requires unique priorities and selectionCriteria`);
      }
    }
  }
}

const secretPattern = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|ghp_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9]{20,})/u;
for (const file of await walkFiles(ROOT)) {
  if (!/\.(?:md|ya?ml|json|mjs|js|ts|txt)$/u.test(file)) continue;
  const content = await readFile(file, "utf8");
  if (secretPattern.test(content)) errors.push(`possible secret in ${path.relative(ROOT, file)}`);
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("repository: valid");
}
