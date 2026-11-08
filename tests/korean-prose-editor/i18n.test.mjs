import { afterEach, describe, expect, it, vi } from "vitest";

import { finalizeRequest } from "../../skills/korean-prose-editor/scripts/finalizer-core.mjs";
import { requireObject } from "../../skills/korean-prose-editor/scripts/lib.mjs";
import { validateProviderPlan } from "../../skills/korean-prose-editor/scripts/provider-plan.mjs";
import { extractProtectedSpans } from "../../skills/korean-prose-editor/scripts/protected-spans.mjs";

// The editing target of this skill is Korean prose; the contract messages shown to the caller render in the model locale (en), whatever the host locale.
describe("korean-prose-editor script messages render in the model locale, whatever the host locale", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  const messageOf = (action) => {
    try { action(); } catch (error) { return { code: error.code, message: error.message }; }
    throw new Error("expected the action to throw");
  };

  it.each([["en"], ["ko"], [undefined]])("renders contract errors in English with the error code when the host locale is %s", (locale) => {
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en");
    if (locale === undefined) delete process.env.AGENT_GOVERNANCE_LOCALE; else vi.stubEnv("AGENT_GOVERNANCE_LOCALE", locale);
    expect(messageOf(() => requireObject(null, "input"))).toEqual({ code: "INVALID_OBJECT", message: "input must be an object" });
    expect(messageOf(() => validateProviderPlan({}, {}))).toEqual({ code: "SUBAGENTS_UNAVAILABLE", message: "three independent language actors are required" });
    expect(messageOf(() => finalizeRequest({ schemaVersion: "1.0.0", mode: "other" }))).toEqual({ code: "MODE", message: "mode must be mcp or direct" });
    expect(() => extractProtectedSpans(1)).toThrow("source must be a string");
  });

  it("does not change the protected-span detection of Korean source text", () => {
    const source = "배포는 2024년 3월 5일에 `npm test`를 실행한다.";
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "en");
    const english = extractProtectedSpans(source);
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "ko");
    expect(extractProtectedSpans(source)).toEqual(english);
  });
});
