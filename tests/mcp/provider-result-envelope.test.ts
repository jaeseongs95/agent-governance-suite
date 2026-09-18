import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { SchemaReferenceV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const registry = new FileSkillRegistry(registryPath, new ContractValidator());
const rootDirectory = registry.rootDirectory;

function providerSchemas(capability: string): { resultSchema: SchemaReferenceV1; outputSchema: SchemaReferenceV1; declaresVersion: boolean } {
  const provider = registry.read().find((candidate) => candidate.capabilities.includes(capability));
  if (!provider) throw new Error(`no provider for ${capability}`);
  const raw = JSON.parse(readFileSync(path.join(rootDirectory, provider.resultSchema), "utf8")) as { properties?: Record<string, unknown> };
  return {
    resultSchema: { path: provider.resultSchema, digest: provider.resultSchemaDigest },
    outputSchema: { path: provider.outputSchema, digest: provider.outputSchemaDigest },
    declaresVersion: Boolean(raw.properties?.schemaVersion),
  };
}

const envelope = {
  schemaVersion: "1.0.0",
  kind: "adapter-error",
  output: null,
  artifacts: [],
  error: { code: "INVALID_INPUT", message: "fixture", details: null },
};

describe("provider result envelope", () => {
  it.each(["acceptance-evidence-validation", "blocker-diagnosis", "recovery-strategy-selection"])(
    "accepts the shared envelope version for %s even though its provider schema omits it",
    (capability) => {
      const { resultSchema, outputSchema, declaresVersion } = providerSchemas(capability);
      expect(declaresVersion).toBe(false);
      const validator = new ContractValidator();
      expect(validator.providerResult(rootDirectory, resultSchema, outputSchema, envelope)).toEqual(envelope);
      // Keys the provider schema does not know are still rejected.
      expect(() => validator.providerResult(rootDirectory, resultSchema, outputSchema, { ...envelope, unexpected: true }))
        .toThrow(/does not match its declared schema/u);
    },
  );

  it("keeps validating schemaVersion where the provider schema declares it", () => {
    const { resultSchema, outputSchema, declaresVersion } = providerSchemas("change-scope-baseline-capture");
    expect(declaresVersion).toBe(true);
    const validator = new ContractValidator();
    expect(validator.providerResult(rootDirectory, resultSchema, outputSchema, envelope)).toEqual(envelope);
    expect(() => validator.providerResult(rootDirectory, resultSchema, outputSchema, { ...envelope, schemaVersion: "9.9.9" }))
      .toThrow(/does not match its declared schema/u);
  });
});
