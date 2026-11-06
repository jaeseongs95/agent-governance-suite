import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const { skills } = JSON.parse(readFileSync(new URL("../../skills/registry.json", import.meta.url), "utf8"));

describe("current model-effort-advisor provider boundary", () => {
  it("selects approved assignments before dispatch without a current-main observation artifact", () => {
    const skill = skills.find((item) => item.skillId === "model-effort-advisor");
    expect(skill.version).toBe("0.2.0");
    expect(skill.providers).toHaveLength(1);
    const provider = skill.providers[0];
    expect(provider.capabilities).toEqual(["subagent-model-selection"]);
    expect(provider.executionClass).toBe("bootstrap");
    expect(provider.requiredInputArtifacts).toEqual(expect.arrayContaining(["subagent-assignment", "host-model-capabilities"]));
    expect(provider.inputBindings.map((item) => item.targetArtifact)).not.toContain("current-model-selection");
    expect(provider.producedArtifacts).toEqual(["subagent-model-advice"]);
    expect(provider.outputSchema).toBe("skills/model-effort-advisor/contracts/subagent-model-advice.v1.schema.json");
    expect(provider.gate).toMatchObject({ kind: "none", policy: "none", validator: null });
    // passed means advice was produced, including advice to hold this dispatch.
    expect(provider.stateMapping.selector).toBe("/output/status");
    for (const status of ["READY", "INHERIT_UNVERIFIED", "BLOCKED"]) {
      expect(provider.stateMapping.values[status]).toEqual({ state: "passed", errorRequired: false });
    }
    expect(provider.stateMapping.values).not.toHaveProperty("ADEQUATE");
  });
});
