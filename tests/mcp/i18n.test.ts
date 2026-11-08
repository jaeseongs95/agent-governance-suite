import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ACCEPT_LANGUAGE_META, localized, lookupLocale, msg, parseLanguageList, render, resolveHostLocale, resolveRequestLocale,
} from "../../mcp-server/src/i18n.js";
import { resolvePackageLocalePath, resolveUserSettingsPath } from "../../mcp-server/src/runtime-config.js";

const files = (entries: Record<string, string>) => (file: string): string => {
  const text = entries[file];
  if (text === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
  return text;
};
const SETTINGS = "/home/user/.agent-governance-suite/settings.json";
const PACKAGE = "/plugin/runtime/locale.json";
// The fixture environment names no shared state directory, so an unpinned signed source would read the tester's home.
const unsigned = () => null;
const host = (environment: NodeJS.ProcessEnv, entries: Record<string, string>) =>
  resolveHostLocale({ environment, settingsPath: SETTINGS, packageLocalePath: PACKAGE, readText: files(entries), signedLocale: unsigned });

describe("language lists (RFC 9110 Accept-Language)", () => {
  it("orders by weight, keeps the written order for ties, drops q=0 and *", () => {
    expect(parseLanguageList("ko;q=0.5, en-us, fr;q=0, *;q=0.1, de;q=0.5")).toEqual(["en-US", "ko", "de"]);
  });

  it("refuses the whole value when any part is not a tag or weight, or it is over the limits", () => {
    expect(parseLanguageList("en, not a tag")).toBeNull();
    expect(parseLanguageList("en;q=2")).toBeNull();
    expect(parseLanguageList("en;level=1")).toBeNull();
    expect(parseLanguageList(`en,${"x".repeat(256)}`)).toBeNull();
    expect(parseLanguageList(Array.from({ length: 17 }, () => "en").join(","))).toBeNull();
    expect(parseLanguageList(42)).toBeNull();
    expect(parseLanguageList("  ")).toBeNull();
  });
});

describe("RFC 4647 Lookup", () => {
  it("shortens each range until a shipped locale matches, dropping a trailing singleton", () => {
    expect(lookupLocale(["en-US"])).toBe("en");
    expect(lookupLocale(["ko-Kore-KR"])).toBe("ko");
    expect(lookupLocale(["ko-x-private"])).toBe("ko");
    expect(lookupLocale(["fr-FR", "ko-KR"])).toBe("ko");
    expect(lookupLocale(["fr", "de"])).toBeNull();
  });
});

describe("host locale (docs/contributing/i18n.md 4.1 ①)", () => {
  it("takes the environment, then user settings, then the package, then en", () => {
    const all = { [SETTINGS]: '{"locale":"en"}', [PACKAGE]: '{"locale":"ko"}' };
    expect(host({ AGENT_GOVERNANCE_LOCALE: "ko-KR" }, { [SETTINGS]: '{"locale":"en"}' })).toMatchObject({ locale: "ko", source: "environment" });
    expect(host({}, all)).toMatchObject({ locale: "en", source: "settings" });
    expect(host({}, { [PACKAGE]: '{"locale":"ko"}' })).toEqual({ locale: "ko", source: "package", skipped: [] });
    expect(host({}, {})).toEqual({ locale: "en", source: "root", skipped: [] });
  });

  it("skips only the unusable source and reports why", () => {
    const resolved = host({ AGENT_GOVERNANCE_LOCALE: "fr" }, { [SETTINGS]: "{not json", [PACKAGE]: '{"locale":"ko"}' });
    expect(resolved).toEqual({
      locale: "ko", source: "package",
      skipped: [{ source: "environment", code: "LOCALE_UNSUPPORTED" }, { source: "settings", code: "LOCALE_SETTINGS_UNREADABLE" }],
    });
    expect(host({ AGENT_GOVERNANCE_LOCALE: "e n" }, { [SETTINGS]: '{"locale":7}' }).skipped)
      .toEqual([{ source: "environment", code: "LOCALE_INVALID" }, { source: "settings", code: "LOCALE_INVALID" }]);
  });

  it("reports a settings file it cannot read, but not one that is absent", () => {
    const denied = (file: string): string => {
      if (file === SETTINGS) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      return '{"locale":"ko"}';
    };
    expect(resolveHostLocale({ environment: {}, settingsPath: SETTINGS, packageLocalePath: PACKAGE, readText: denied, signedLocale: unsigned }).skipped)
      .toEqual([{ source: "settings", code: "LOCALE_SETTINGS_UNREADABLE" }]);
    expect(resolveHostLocale({ environment: {}, settingsPath: null, packageLocalePath: PACKAGE, readText: denied, signedLocale: unsigned }).skipped)
      .toEqual([{ source: "settings", code: "LOCALE_SETTINGS_UNREADABLE" }]);
  });

  it("places the settings beside the shared host state and the package locale in runtime/", () => {
    expect(resolveUserSettingsPath({ AGENT_GOVERNANCE_SHARED_STATE_DIR: path.resolve("/srv/ags") }, "/home/user"))
      .toBe(path.join(path.resolve("/srv/ags"), "settings.json"));
    expect(resolveUserSettingsPath({}, path.resolve("/home/user")))
      .toBe(path.join(path.resolve("/home/user"), ".agent-governance-suite", "settings.json"));
    expect(resolvePackageLocalePath(pathToFileURL(path.resolve("/plugin/mcp-server/dist/server.mjs")).href)).toBe(path.resolve("/plugin/runtime/locale.json"));
  });
});

describe("request locale (docs/contributing/i18n.md 4.1 ②)", () => {
  it("uses the SEP-2792 _meta value and falls back to the service default", () => {
    expect(resolveRequestLocale({ [ACCEPT_LANGUAGE_META]: "ko-KR, en;q=0.5" }, "en")).toBe("ko");
    expect(resolveRequestLocale({ [ACCEPT_LANGUAGE_META]: "fr" }, "ko")).toBe("ko");
    expect(resolveRequestLocale({ [ACCEPT_LANGUAGE_META]: "x".repeat(300) }, "ko")).toBe("ko");
    expect(resolveRequestLocale(undefined, "en")).toBe("en");
  });
});

describe("rendering", () => {
  const denied = (earlier: number) => msg("hooks.editGate.denied", { limit: 3, paths: "a.ts, b.ts", earlier, example: "start_workflow {\"goal\":\"<목표>\"}" });

  it("renders the same key and params in each locale, with plural and ordinal rules", () => {
    expect(render(denied(0), "ko")).toBe("[AGS] workflow 없이 제품 파일 3개째 변경: a.ts, b.ts. 먼저 workflow를 시작하라(최소 시작 호출 예: start_workflow {\"goal\":\"<목표>\"}).");
    expect(render(denied(2), "ko")).toContain("a.ts, b.ts (앞서 바꾼 제품 파일 2개 포함).");
    expect(render(denied(1), "en")).toBe("[AGS] Changing a 3rd product file without a workflow: a.ts, b.ts (including 1 product file changed earlier). Start a workflow first (minimal start call: start_workflow {\"goal\":\"<목표>\"}).");
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
