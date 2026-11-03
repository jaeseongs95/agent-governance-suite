import { afterEach, describe, expect, it, vi } from "vitest";

import { finalizeRequest } from "../../skills/korean-prose-editor/scripts/finalizer-core.mjs";
import { requireObject } from "../../skills/korean-prose-editor/scripts/lib.mjs";
import { validateProviderPlan } from "../../skills/korean-prose-editor/scripts/provider-plan.mjs";
import { extractProtectedSpans } from "../../skills/korean-prose-editor/scripts/protected-spans.mjs";

// The editing target of this skill is Korean prose; only the contract messages shown to the caller follow the host locale.
describe("korean-prose-editor script messages follow the host locale", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const messageOf = (action) => {
    try { action(); } catch (error) { return { code: error.code, message: error.message }; }
    throw new Error("expected the action to throw");
  };

  it("renders contract errors in English and Korean while keeping the error code", () => {
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en");
    expect(messageOf(() => requireObject(null, "input"))).toEqual({ code: "INVALID_OBJECT", message: "input must be an object" });
    expect(messageOf(() => validateProviderPlan({}, {}))).toEqual({ code: "SUBAGENTS_UNAVAILABLE", message: "three independent language actors are required" });
    expect(messageOf(() => finalizeRequest({ schemaVersion: "1.0.0", mode: "other" }))).toEqual({ code: "MODE", message: "mode must be mcp or direct" });
    expect(() => extractProtectedSpans(1)).toThrow("source must be a string");

    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "ko");
    expect(messageOf(() => requireObject(null, "input"))).toEqual({ code: "INVALID_OBJECT", message: "객체여야 한다: input" });
    expect(messageOf(() => validateProviderPlan({}, {}))).toEqual({ code: "SUBAGENTS_UNAVAILABLE", message: "서로 독립된 언어 행위자 3개가 필요하다" });
    expect(messageOf(() => finalizeRequest({ schemaVersion: "1.0.0", mode: "other" }))).toEqual({ code: "MODE", message: "mode는 mcp 또는 direct여야 한다" });
    expect(() => extractProtectedSpans(1)).toThrow("source는 문자열이어야 한다");
  });

  it("does not change the protected-span detection of Korean source text", () => {
    const source = "배포는 2024년 3월 5일에 `npm test`를 실행한다.";
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en");
    const english = extractProtectedSpans(source);
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "ko");
    expect(extractProtectedSpans(source)).toEqual(english);
  });
});
