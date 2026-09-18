import { describe, expect, it } from "vitest";

import { assertConcreteKoreanProseExecutionProvenance } from "../../scripts/korean-prose-execution-provenance.js";

const verified = {
  requestedModel: "requested-model",
  actualModel: "actual-model-2026-09-14",
  provider: "fixture-provider",
  providerVersion: "2026.09.14",
  promptSha256: "a".repeat(64),
  seed: "unverified" as const,
  decodingParametersSha256: "unverified" as const,
};

describe("Korean prose execution provenance", () => {
  it("accepts recorded provider identity even when the provider exposes no seed", () => {
    expect(() => assertConcreteKoreanProseExecutionProvenance(verified, "selection")).not.toThrow();
  });

  it.each(["actualModel", "provider", "providerVersion"] as const)(
    "rejects an unverified %s",
    (field) => {
      expect(() => assertConcreteKoreanProseExecutionProvenance({ ...verified, [field]: "unverified" }, "selection"))
        .toThrow("unverified identity field");
    },
  );

  it("rejects an invalid prompt digest", () => {
    expect(() => assertConcreteKoreanProseExecutionProvenance({ ...verified, promptSha256: "short" }, "selection"))
      .toThrow("invalid prompt digest");
  });
});
