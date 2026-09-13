#!/usr/bin/env node

import { readFileSync } from "node:fs";

const defaultRegistryUrl = new URL("../../registry.json", import.meta.url);

function fail(message, exitCode = 2) {
  process.stderr.write(`${message}\n`);
  process.exit(exitCode);
}

function parseArguments(argv) {
  const capabilities = [];
  let all = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--capability") {
      const capability = argv[index + 1];
      if (!capability || capability.startsWith("--")) fail("--capability requires a non-empty value.");
      capabilities.push(capability);
      index += 1;
      continue;
    }
    fail(`Unknown argument: ${argument}`);
  }
  if (all && capabilities.length > 0) fail("Use --all or --capability, not both.");
  if (!all && capabilities.length === 0) fail("Specify at least one --capability value or use --all.");
  return { all, capabilities: [...new Set(capabilities)] };
}

function readRegistry() {
  const registryPath = process.env.SKILL_REGISTRY_PATH || defaultRegistryUrl;
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    fail(`Unable to read skill registry: ${error instanceof Error ? error.message : String(error)}`, 1);
  }
  if (registry?.schemaVersion !== "2.0.0" || !Array.isArray(registry.skills)) {
    fail("Skill registry must be a SkillDescriptor.v2 collection.", 1);
  }
  return registry;
}

function compactProviders(registry, query) {
  const requested = new Set(query.capabilities);
  const providers = [];
  const matched = new Set();
  for (const skill of registry.skills) {
    if (skill?.enabled !== true || !Array.isArray(skill.providers)) continue;
    skill.providers.forEach((provider, providerIndex) => {
      if (!provider || !Array.isArray(provider.capabilities)) return;
      const matches = query.all || provider.capabilities.some((capability) => requested.has(capability));
      if (!matches) return;
      provider.capabilities.forEach((capability) => {
        if (requested.has(capability)) matched.add(capability);
      });
      providers.push({
        skillId: skill.skillId,
        version: skill.version,
        providerIndex,
        capabilities: provider.capabilities,
        executionClass: provider.executionClass,
        phase: provider.phase,
        phaseOrder: provider.phaseOrder,
        priority: skill.priority,
        selectionCriteria: provider.selectionCriteria,
        preconditions: provider.preconditions,
        gate: {
          kind: provider.gate?.kind,
          policy: provider.gate?.policy,
        },
      });
    });
  }
  providers.sort((left, right) => (
    left.phaseOrder - right.phaseOrder
    || left.skillId.localeCompare(right.skillId)
    || left.providerIndex - right.providerIndex
  ));
  return {
    providers,
    missingCapabilities: query.all ? [] : query.capabilities.filter((capability) => !matched.has(capability)),
  };
}

const query = parseArguments(process.argv.slice(2));
const registry = readRegistry();
const compact = compactProviders(registry, query);
process.stdout.write(`${JSON.stringify({
  schemaVersion: "1.0.0",
  query,
  ...compact,
})}\n`);
