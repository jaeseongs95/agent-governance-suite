import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

describe("bundled skill registry", () => {
  it("conforms to SkillDescriptor.v1 and exposes policy capabilities", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const capabilities = new Set(registry.read().flatMap((skill) => skill.capabilities));

    expect(capabilities.has("subagent-coordination")).toBe(true);
    expect(capabilities.has("independent-deliberation")).toBe(true);
    expect(capabilities.has("independent-audit")).toBe(true);
  });
});
