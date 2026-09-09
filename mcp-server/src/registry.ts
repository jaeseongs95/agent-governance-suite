import { readFileSync } from "node:fs";

import { type SkillDescriptorV1, WorkflowContractError } from "../../contracts/types.js";
import { ContractValidator } from "./schema-validator.js";

interface RegistryDocument {
  skills?: unknown[];
}

/**
 * The registry is deliberately re-read for each plan request. It is not workflow
 * state and no registry data is persisted by this MCP server.
 */
export class FileSkillRegistry {
  constructor(
    private readonly registryPath: string,
    private readonly validator: ContractValidator,
  ) {}

  read(): SkillDescriptorV1[] {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.registryPath, "utf8")) as unknown;
    } catch (cause) {
      throw new WorkflowContractError("INVALID_INPUT", "Cannot read the skill registry.", {
        registryPath: this.registryPath,
        cause: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const candidates = Array.isArray(raw) ? raw : this.registrySkills(raw as Partial<RegistryDocument>);
    const skills = candidates.map((candidate) => this.validator.skillDescriptor(candidate));
    const ids = new Set<string>();
    for (const skill of skills) {
      if (ids.has(skill.id)) {
        throw new WorkflowContractError("INVALID_INPUT", "Registry contains duplicate skillId values.", {
          skillId: skill.id,
        });
      }
      ids.add(skill.id);
    }
    return skills;
  }

  private registrySkills(value: Partial<RegistryDocument>): unknown[] {
    if (!Array.isArray(value?.skills)) {
      throw new WorkflowContractError("INVALID_INPUT", "Registry must be an array or an object with a skills array.");
    }
    return value.skills;
  }
}

export function selectSkillByCapability(
  skills: SkillDescriptorV1[],
  capability: string,
): SkillDescriptorV1 | undefined {
  return skills
    .filter((skill) => skill.enabled && skill.capabilities.includes(capability))
    .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id))[0];
}
