import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { type RoutedSkillProviderV2, type SkillDescriptorV2, WorkflowContractError } from "../../contracts/types.js";
import { ContractValidator } from "./schema-validator.js";

interface RegistryDocument {
  schemaVersion?: unknown;
  skills?: unknown[];
}

/** Re-read registry metadata for each plan so new providers need no MCP code change. */
export class FileSkillRegistry {
  readonly rootDirectory: string;

  constructor(
    private readonly registryPath: string,
    private readonly validator: ContractValidator,
  ) {
    this.rootDirectory = path.dirname(path.dirname(path.resolve(registryPath)));
  }

  read(): RoutedSkillProviderV2[] {
    let raw: RegistryDocument;
    try {
      raw = JSON.parse(readFileSync(this.registryPath, "utf8")) as RegistryDocument;
    } catch (cause) {
      throw new WorkflowContractError("INVALID_INPUT", "Cannot read the skill registry.", {
        registryPath: this.registryPath,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
    if (raw.schemaVersion !== "2.0.0" || !Array.isArray(raw.skills)) {
      throw new WorkflowContractError("INVALID_INPUT", "Registry must be a v2 object with a skills array.");
    }

    const descriptors = raw.skills.map((candidate) => this.validator.skillDescriptorV2(candidate));
    const skillIds = new Set<string>();
    const providers: RoutedSkillProviderV2[] = [];
    for (const descriptor of descriptors) {
      this.assertDescriptorPath(descriptor);
      if (skillIds.has(descriptor.skillId)) {
        throw new WorkflowContractError("INVALID_INPUT", "Registry contains duplicate skillId values.", {
          skillId: descriptor.skillId,
        });
      }
      skillIds.add(descriptor.skillId);
      for (const [index, provider] of descriptor.providers.entries()) {
        const providerKey = `${descriptor.skillId}:${provider.phase}:${index + 1}`;
        providers.push({
          ...provider,
          gate: this.routeGateValidator(provider.gate),
          skillId: descriptor.skillId,
          version: descriptor.version,
          path: descriptor.path,
          enabled: descriptor.enabled,
          priority: descriptor.priority,
          providerKey,
          outputSchemaDigest: this.schemaDigest(provider.outputSchema),
          resultSchemaDigest: this.schemaDigest(provider.resultSchema),
        });
      }
    }
    this.assertProviderConflicts(providers);
    return providers;
  }

  private assertDescriptorPath(descriptor: SkillDescriptorV2): void {
    if (descriptor.path !== `./${descriptor.skillId}`) {
      throw new WorkflowContractError("INVALID_INPUT", "Registry path must match skillId.", {
        skillId: descriptor.skillId,
        path: descriptor.path,
      });
    }
    const skillRoot = path.resolve(this.rootDirectory, "skills", descriptor.skillId);
    for (const provider of descriptor.providers) {
      const bindings = new Set(provider.inputBindings.map((binding) => binding.targetArtifact));
      for (const artifact of provider.requiredInputArtifacts) {
        if (!bindings.has(artifact)) {
          throw new WorkflowContractError("INVALID_INPUT", "Every required input artifact needs an input binding.", {
            skillId: descriptor.skillId,
            phase: provider.phase,
            artifact,
          });
        }
      }
      const gateSchema = provider.gate.validator?.endsWith(".schema.json") ? provider.gate.validator : null;
      for (const schemaPath of [provider.outputSchema, provider.resultSchema, ...(gateSchema ? [gateSchema] : [])]) {
        const resolved = path.resolve(this.rootDirectory, schemaPath);
        if (resolved !== this.rootDirectory && !resolved.startsWith(`${this.rootDirectory}${path.sep}`)) {
          throw new WorkflowContractError("INVALID_INPUT", "Provider schema path escapes the plugin root.", {
            skillId: descriptor.skillId,
            schemaPath,
          });
        }
        if (schemaPath.startsWith("skills/") && resolved !== skillRoot && !resolved.startsWith(`${skillRoot}${path.sep}`)) {
          throw new WorkflowContractError("INVALID_INPUT", "Skill-local schema path must remain inside its skill directory.", {
            skillId: descriptor.skillId,
            schemaPath,
          });
        }
      }
    }
  }

  private schemaDigest(relativePath: string): string {
    try {
      return `sha256:${createHash("sha256").update(readFileSync(path.resolve(this.rootDirectory, relativePath))).digest("hex")}`;
    } catch (cause) {
      throw new WorkflowContractError("INVALID_INPUT", "Cannot read a provider schema.", {
        schemaPath: relativePath,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private routeGateValidator(gate: RoutedSkillProviderV2["gate"]): RoutedSkillProviderV2["gate"] {
    const validator = gate.validator;
    return validator?.endsWith(".schema.json")
      ? { ...gate, validatorSchema: { path: validator, digest: this.schemaDigest(validator) } }
      : { ...gate, validatorSchema: null };
  }

  private assertProviderConflicts(providers: RoutedSkillProviderV2[]): void {
    const owners = new Map<string, RoutedSkillProviderV2[]>();
    for (const provider of providers.filter((candidate) => candidate.enabled)) {
      for (const capability of provider.capabilities) {
        owners.set(capability, [...(owners.get(capability) ?? []), provider]);
      }
    }
    for (const [capability, candidates] of owners) {
      if (candidates.length < 2) continue;
      const priorities = new Set(candidates.map((candidate) => candidate.priority));
      if (priorities.size !== candidates.length || candidates.some((candidate) => candidate.selectionCriteria.length === 0)) {
        throw new WorkflowContractError("INVALID_INPUT", "Overlapping capability providers require unique priorities and selection criteria.", {
          capability,
          providers: candidates.map((candidate) => candidate.providerKey),
        });
      }
    }
  }
}

export function selectSkillByCapability(
  providers: RoutedSkillProviderV2[],
  capability: string,
): RoutedSkillProviderV2 | undefined {
  return providers
    .filter((provider) => provider.enabled && provider.capabilities.includes(capability))
    .sort((left, right) => right.priority - left.priority || left.providerKey.localeCompare(right.providerKey))[0];
}
