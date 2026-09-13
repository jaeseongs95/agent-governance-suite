import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const queryScript = fileURLToPath(new URL("../../skills/orchestrator/scripts/query-registry.mjs", import.meta.url));

function query(...args) {
  const result = spawnSync(process.execPath, [queryScript, ...args], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    encoding: "utf8",
    windowsHide: true,
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return { raw: result.stdout, value: JSON.parse(result.stdout) };
}

describe("compact orchestrator registry query", () => {
  it("projects every enabled provider deterministically below 25% of the registry bytes", () => {
    const registryText = readFileSync(registryPath, "utf8");
    const registry = JSON.parse(registryText);
    const output = query("--all");
    const expected = registry.skills.flatMap((skill) => (
      skill.enabled === true
        ? skill.providers.map((provider, providerIndex) => ({ skill, provider, providerIndex }))
        : []
    )).map(({ skill, provider, providerIndex }) => ({
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
      gate: { kind: provider.gate.kind, policy: provider.gate.policy },
    })).sort((left, right) => (
      left.phaseOrder - right.phaseOrder
      || left.skillId.localeCompare(right.skillId)
      || left.providerIndex - right.providerIndex
    ));

    expect(output.value.providers).toHaveLength(expected.length);
    expect(output.value.providers).toEqual(expected);
    expect(output.value.missingCapabilities).toEqual([]);
    expect(output.raw.length).toBeLessThanOrEqual(registryText.length * 0.25);
    expect(Buffer.byteLength(output.raw)).toBeLessThanOrEqual(Buffer.byteLength(registryText) * 0.25);
  });

  it("returns only matching providers and reports unavailable capabilities", () => {
    const matching = query("--capability", "mutation-risk-preflight").value;
    expect(matching.providers.length).toBeGreaterThan(0);
    expect(matching.providers.every((provider) => provider.capabilities.includes("mutation-risk-preflight"))).toBe(true);
    expect(matching.missingCapabilities).toEqual([]);

    const missing = query("--capability", "not-installed-capability").value;
    expect(missing.providers).toEqual([]);
    expect(missing.missingCapabilities).toEqual(["not-installed-capability"]);
  });
});
