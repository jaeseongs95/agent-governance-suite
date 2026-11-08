import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as i18n from "../../mcp-server/src/i18n.js";
import { localized, MODEL_LOCALE, msg, render } from "../../mcp-server/src/i18n.js";
import * as runtimeConfig from "../../mcp-server/src/runtime-config.js";

// 4.0.0 (user decision 2026-11-08, 「전부 정리」): everything AGS renders is read by a model first, so it is rendered in
// MODEL_LOCALE whatever the host. The locale chain (environment, signed admin setting, user settings, package
// runtime/locale.json, request Accept-Language) is removed, and its parsing and precedence tests with it.
describe("model locale", () => {
  it("is English, and the removed locale chain has no entry point left", () => {
    expect(MODEL_LOCALE).toBe("en");
    for (const removed of ["ACCEPT_LANGUAGE_META", "LOCALE_ENVIRONMENT", "parseLanguageList", "lookupLocale", "resolveHostLocale", "resolveRequestLocale"])
      expect(Object.hasOwn(i18n, removed), removed).toBe(false);
    for (const removed of ["resolveUserSettingsPath", "resolvePackageLocalePath"])
      expect(Object.hasOwn(runtimeConfig, removed), removed).toBe(false);
    expect(existsSync(fileURLToPath(new URL("../../runtime/locale.json", import.meta.url)))).toBe(false);
  });
});

describe("rendering", () => {
  const denied = (earlier: number) => msg("hooks.editGate.denied", { limit: 3, paths: "a.ts, b.ts", earlier, example: "start_workflow {\"goal\":\"<목표>\"}" });

  it("renders the same key and params in each locale, with plural and ordinal rules", () => {
    expect(render(denied(0), "ko")).toBe("[AGS] workflow 없이 제품 파일 3개째 변경: a.ts, b.ts. 먼저 workflow를 시작하라(최소 시작 호출 예: start_workflow {\"goal\":\"<목표>\"}).");
    expect(render(denied(2), "ko")).toContain("a.ts, b.ts (앞서 바꾼 제품 파일 2개 포함).");
    expect(render(denied(1), "en")).toBe("[AGS] Product file #3 changed without a workflow: a.ts, b.ts (incl. 1 changed earlier). Start a workflow first (minimal call: start_workflow {\"goal\":\"<목표>\"}).");
    expect(render(denied(2), "en")).toContain("(including 2 product files changed earlier)");
  });

  it("renders a message nested in params in the same locale", () => {
    const sent = msg("server.sessionMessage.sendInvalid", { cause: msg("server.call.reservedCallerField", {}) });
    expect(render(sent, "ko").startsWith("호출자 신원은 호스트가 정하므로 도구 인자로 받지 않는다. ")).toBe(true);
    expect(render(sent, "en").startsWith("Caller identity is host-owned and is not accepted in tool arguments. Use prepare_session_message")).toBe(true);
    // Stored bodies read back as JSON nest the same way.
    expect(render(JSON.parse(JSON.stringify(sent)) as typeof sent, "ko")).toBe(render(sent, "ko"));
  });

  it("never throws on a key from another AGS version", () => {
    expect(render({ key: "hooks.fromLaterVersion", params: { n: 1 } }, "ko")).toBe("hooks.fromLaterVersion");
  });

  it("puts the language-independent key and params on the wire beside the text", () => {
    expect(localized(denied(0), "en")).toMatchObject({ messageKey: "hooks.editGate.denied", params: { limit: 3, earlier: 0 }, locale: "en" });
  });

  it("rejects unknown keys and wrong params at compile time", () => {
    // @ts-expect-error not a catalog key
    expect(() => msg("hooks.noSuchKey", {})).not.toThrow();
    // @ts-expect-error earlier must be a number
    expect(() => msg("hooks.editGate.denied", { limit: 3, paths: "a", earlier: "2", example: "x" })).not.toThrow();
    // @ts-expect-error example is missing
    expect(() => msg("hooks.editGate.denied", { limit: 3, paths: "a", earlier: 0 })).not.toThrow();
  });
});
