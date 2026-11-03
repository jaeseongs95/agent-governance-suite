import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  it("preserves only the literal missing-demand rationale code across the public CLI boundary", () => {
    const item = structuredClone(cases.find((value) => value.id === "trusted-provider-q"));
    item.advice.verdict = "UNOBSERVABLE";
    item.advice.observation = { status: "unobservable", source: null, model: null, modelClass: null, reasoningEffort: null };
    item.advice.rationaleCodes = ["CURRENT_SELECTION_NOT_OBSERVED"];
    item.advice.userNotice = null;
    const request = JSON.stringify({ advice: item.advice, context: item.context });
    expect(() => guardModelSupport(item.advice, item.context)).toThrow("MISSING_DEMAND_RATIONALE");
    const result = spawnSync(process.execPath, [cli], { input: request, encoding: "utf8" });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("MISSING_DEMAND_RATIONALE\n");
    expect(JSON.stringify({ advice: item.advice, context: item.context })).toBe(request);
  });
  it("keeps schema failures and caller-supplied reason strings generic without echoing them", () => {
    for (const input of [
      JSON.stringify({ advice: { userNotice: "secret-sentinel", rationaleCodes: ["MISSING_DEMAND_RATIONALE"] } }),
      JSON.stringify({ advice: "MISSING_DEMAND_RATIONALE secret-sentinel" }),
    ]) {
      const result = spawnSync(process.execPath, [cli], { input, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("INVALID_INPUT\n");
      expect(result.stderr).not.toContain("secret-sentinel");
    }
  });
});

describe("model effort notices follow the host locale", () => {
  afterEach(() => vi.unstubAllEnvs());
  const noticeIn = (locale, item) => {
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", locale);
    return guardModelSupport(item.advice, item.context).advice.userNotice;
  };
  it("renders the range notice in Korean and in English from the same verdict", () => {
    const item = cases.find((value) => value.id === "material-over-fit");
    const range = (value) => value.match(/(\w+)~(\w+) \/ (\w+)~(\w+)/u).slice(1, 5);
    const korean = noticeIn("ko", item);
    const english = noticeIn("en", item);
    expect(korean).toMatch(/^설정 안내: 이 요청의 권장 범위는 .+입니다\. 현재 설정은 다소 과합니다\. 설정은 자동으로 바꾸지 않고 요청은 계속 진행합니다\.$/u);
    expect(english).toMatch(/^Setting notice: the recommended range for this request is .+\. The current setting is somewhat excessive\. The setting is not changed automatically, and the request continues\.$/u);
    expect(range(english)).toEqual(range(korean));
  });
  it("renders the under-provisioned wording and the unobserved notice in both locales", () => {
    const item = structuredClone(cases.find((value) => value.id === "material-over-fit"));
    item.context.currentSelection.model = "q-general";
    item.context.currentSelection.reasoningEffort = "medium";
    Object.assign(item.advice.recommendation, { modelClassMin: "deep", modelClassMax: "frontier", reasoningEffortMin: "high", reasoningEffortMax: "max" });
    expect(noticeIn("ko", item)).toContain("현재 설정은 부족할 수 있습니다.");
    expect(noticeIn("en", item)).toContain("The current setting may be insufficient.");
    const unobserved = cases.find((value) => value.id === "unmapped-current-model");
    expect(noticeIn("ko", unobserved)).toBe("현재 설정 또는 해당 공급자의 지원 근거를 충분히 확인할 수 없습니다. 설정을 바꾸지 않고 요청을 계속 진행합니다.");
    expect(noticeIn("en", unobserved)).toBe("Cannot sufficiently confirm the current setting or the provider's support evidence. The request continues without changing any setting.");
  });
});
