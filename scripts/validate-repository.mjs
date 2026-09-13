import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { ROOT, readJson, walkFiles } from "./lib.mjs";
import { syncReleaseMetadata } from "./release-metadata.mjs";
import { verifySourceLockOffline } from "./source-lock.mjs";
import { validateSkill } from "./validate-skill.mjs";

const requiredFiles = [
  ".codex-plugin/plugin.json",
  ".agents/plugins/marketplace.json",
  ".mcp.json",
  "skills/registry.json",
  "skills/source-lock.json",
  "contracts/source-lock.v2.schema.json",
  "release/version.json",
  "mcp-server/dist/server.mjs",
  "mcp-server/dist/continuity-hook.mjs",
  "hooks/hooks.json",
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
  try {
    await syncReleaseMetadata();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
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

  const koreanRegistryDescriptor = registry.find((descriptor) => descriptor.skillId === "korean-prose-editor");
  if (!koreanRegistryDescriptor) {
    errors.push("korean-prose-editor must remain represented in the registry");
  } else {
    const [directDescriptor, openAiConfig, skillInstructions] = await Promise.all([
      readJson(path.join(ROOT, "skills", "korean-prose-editor", "integration", "skill-descriptor.json")),
      readFile(path.join(ROOT, "skills", "korean-prose-editor", "agents", "openai.yaml"), "utf8"),
      readFile(path.join(ROOT, "skills", "korean-prose-editor", "SKILL.md"), "utf8"),
    ]);
    const implicitInvocationDisabled = /^\s*allow_implicit_invocation:\s*false\s*$/mu.test(openAiConfig);
    const disabledMarkerPresent = skillInstructions.includes("TEMPORARILY_DISABLED");
    if (koreanRegistryDescriptor.enabled !== false
      || directDescriptor.enabled !== false
      || !implicitInvocationDisabled
      || !disabledMarkerPresent) {
      errors.push("korean-prose-editor activation surfaces must remain disabled until a separately approved activation change");
    }
  }

  const sourceLock = await readJson(path.join(ROOT, "skills", "source-lock.json"));
  const sourceLockSchema = await readJson(path.join(ROOT, "contracts", "source-lock.v2.schema.json"));
  const validateSourceLock = ajv.compile(sourceLockSchema);
  if (!validateSourceLock(sourceLock)) {
    errors.push(`invalid source lock: ${ajv.errorsText(validateSourceLock.errors)}`);
  }
  errors.push(...await verifySourceLockOffline());

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
