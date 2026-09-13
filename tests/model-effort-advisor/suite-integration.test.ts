import { Ajv2020 } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const schemaPath = fileURLToPath(new URL(
  "../../skills/model-effort-advisor/contracts/model-effort-advice.v1.schema.json",
  import.meta.url,
));
const casesPath = fileURLToPath(new URL("./behavior-cases.json", import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const fixture = JSON.parse(readFileSync(casesPath, "utf8")) as {
  cases: Array<{
    id: string;
    output: Record<string, unknown> & { verdict: string; userNotice: string | null };
  }>;
  invalidCases: Array<{ id: string; output: Record<string, unknown> }>;
};
const cases = fixture.cases;

describe("model-effort-advisor", () => {
  it("keeps representative outputs inside ModelEffortAdvice.v1", () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    for (const testCase of cases) {
      expect(validate(testCase.output), `${testCase.id}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });

  it("rejects invalid observation claims, risk floors, and recommendation ranges", () => {
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    for (const testCase of fixture.invalidCases) {
      expect(validate(testCase.output), testCase.id).toBe(false);
    }

    expect(fixture.invalidCases.map((testCase) => testCase.id)).toEqual(expect.arrayContaining([
      "mismatch-without-observed-selection",
      "high-risk-below-model-floor",
      "high-risk-below-effort-floor",
      "critical-risk-below-model-floor",
      "inverted-model-range",
      "inverted-reasoning-range",
    ]));
  });

  it("warns only on observed material mismatches", () => {
    const byId = Object.fromEntries(cases.map((testCase) => [testCase.id, testCase.output]));
    const output = (id: string) => {
      const value = byId[id];
      if (!value) throw new Error(`missing behavior case: ${id}`);
      return value;
    };

    expect(output("routine-sol-high-is-materially-over").verdict).toBe("OVER_PROVISIONED");
    expect(output("high-risk-lightweight-low-is-under").verdict).toBe("UNDER_PROVISIONED");
    expect(output("complex-sol-high-is-adequate").userNotice).toBeNull();
    expect(output("unobservable-does-not-invent-current-selection").userNotice).toBeNull();

    const criticalFloor = output("critical-deep-high-is-exact-floor").recommendation as {
      modelClassMin: string;
      reasoningEffortMin: string;
    };
    expect(criticalFloor.modelClassMin).toBe("deep");
    expect(criticalFloor.reasoningEffortMin).toBe("high");
  });
});
