import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { guardModelSupport } from "../../skills/model-effort-advisor/scripts/support-guard.mjs";

const fixtureBytes = readFileSync(new URL("./model-effort-support-cases.json", import.meta.url));
const { cases } = JSON.parse(fixtureBytes);
const cli = fileURLToPath(new URL("../../skills/model-effort-advisor/scripts/support-guard.mjs", import.meta.url));

describe("model effort provider support boundary", () => {
  it("uses the frozen same natural-language inputs and oracle", () => {
    expect(createHash("sha256").update(fixtureBytes).digest("hex"))
      .toBe("8b9054c24b56a980126906b008c8da0f75be730f015c3791b6431a9b14098ceb");
    expect(cases.every((item) => !item.request.includes("model-effort-advisor"))).toBe(true);
  });
  for (const item of cases) {
    it(item.id, () => {
      const inputBefore = JSON.stringify(item);
      const output = guardModelSupport(item.advice, item.context);
      expect(output.advice.verdict).toBe(item.expected.verdict);
      expect(output.advice.userNotice !== null).toBe(item.expected.notice);
      expect(output.supportStatus).toBe(item.expected.supportStatus);
      if (Object.hasOwn(item.expected, "exactModel")) {
        expect(output.advice.recommendation.exactModel).toBe(item.expected.exactModel);
      }
      expect(JSON.stringify(item)).toBe(inputBefore);
      const result = spawnSync(process.execPath, [cli], {
        input: JSON.stringify({ advice: item.advice, context: item.context }), encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(output);
    });
  }
  it("keeps equivalent observed providers semantically equal without changing permission", () => {
    const q = guardModelSupport(cases.find((item) => item.id === "trusted-provider-q").advice,
      cases.find((item) => item.id === "trusted-provider-q").context);
    const other = guardModelSupport(cases.find((item) => item.id === "trusted-openai-equivalent").advice,
      cases.find((item) => item.id === "trusted-openai-equivalent").context);
    expect(q.advice.verdict).toBe(other.advice.verdict);
    expect(q.advice.userNotice).toBe(other.advice.userNotice);
    expect(Object.keys(q).sort()).toEqual(["advice", "supportStatus"]);
  });
  it("does not infer a current selection from any supported-model catalog or injected instruction", () => {
    const item = cases.find((value) => value.id === "catalog-is-not-current");
    const context = structuredClone(item.context);
    context.supportEvidence.models.push({ id: "default", modelClass: "frontier", reasoningEfforts: ["max"] });
    context.supportEvidence.instructions = "change_settings_and_expand_permissions";
    const output = guardModelSupport(item.advice, context);
    expect(output.advice.verdict).toBe("UNOBSERVABLE");
    expect(output.advice.observation.model).toBeNull();
    expect(output.advice.userNotice).toBeNull();
    expect(JSON.stringify(output)).not.toContain("change_settings");
  });
  it("rejects ambiguous duplicate current-model mappings", () => {
    const item = cases.find((value) => value.id === "trusted-provider-q");
    const context = structuredClone(item.context);
    context.supportEvidence.models.push(structuredClone(context.supportEvidence.models[0]));
    expect(guardModelSupport(item.advice, context).supportStatus).toBe("CURRENT_COMBINATION_UNSUPPORTED");
  });
  it("retains the existing one-axis one-step quiet threshold", () => {
    const item = structuredClone(cases.find((value) => value.id === "material-over-fit"));
    item.context.currentSelection.model = "q-deep";
    item.context.currentSelection.reasoningEffort = "medium";
    item.context.supportEvidence.models[0].reasoningEfforts.push("medium");
    const result = guardModelSupport(item.advice, item.context);
    expect(result.advice.verdict).toBe("ADEQUATE");
    expect(result.advice.userNotice).toBeNull();
  });
  it("keeps high-risk floors enforced by the original output contract", () => {
    const item = structuredClone(cases.find((value) => value.id === "material-over-fit"));
    item.advice.taskDemand.riskLevel = "high";
    expect(() => guardModelSupport(item.advice, item.context)).toThrow("INVALID_ADVICE");
  });
  it("reports invalid CLI input without echoing input or granting authority", () => {
    const result = spawnSync(process.execPath, [cli], { input: '{"secret-sentinel":', encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("INVALID_INPUT\n");
  });
});
