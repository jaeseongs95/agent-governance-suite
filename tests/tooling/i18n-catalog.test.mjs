import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../scripts/lib.mjs";
import { checkCatalogs, GENERATED, loadCatalogs, renderGenerated } from "../../scripts/i18n.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const SOURCE = "{count, plural, one {# file} other {# files}} in {where}";

/** A two-locale catalog whose en source and reviewed ko translation are valid; `change` breaks one part. */
function fixture(change = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "ags-i18n-"));
  roots.push(root);
  const write = (relative, value) => {
    mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    writeFileSync(path.join(root, relative), JSON.stringify(value));
  };
  const en = change.en ?? { "cli.files": SOURCE };
  write("locales/catalog.json", change.catalog ?? { schemaVersion: "1.0.0", rootLocale: "en", locales: ["en", "ko"], domains: { cli: { sourceLocale: "en" } } });
  write("locales/en/cli.json", en);
  write("locales/ko/cli.json", change.ko ?? { "cli.files": "{where}에 파일 {count, number}개" });
  write("locales/ko/translations.lock.json", change.lock ?? { "cli.files": sha(en["cli.files"] ?? "") });
  return root;
}

describe("message catalog checks (docs/contributing/i18n.md 5.3)", () => {
  it("passes a complete, reviewed catalog", () => {
    expect(checkCatalogs(fixture())).toEqual([]);
  });

  it("reports a missing and an extra translation", () => {
    expect(checkCatalogs(fixture({ ko: { "cli.other": "x" } }))).toEqual([
      "ko cli.files: missing translation",
      "ko cli.other: not in the en source",
    ]);
  });

  it("reports a message ICU cannot parse", () => {
    expect(checkCatalogs(fixture({ ko: { "cli.files": "{where" } }))[0]).toMatch(/^ko cli\.files: /u);
  });

  it("reports placeholders that differ from the source, and a kind the source values do not fit", () => {
    expect(checkCatalogs(fixture({ ko: { "cli.files": "{place}에 파일 {count, number}개" } })))
      .toEqual(["ko cli.files: placeholders {count,place} differ from the source {count,where}"]);
    expect(checkCatalogs(fixture({ ko: { "cli.files": "{where, number}에 파일 {count, number}개" } })))
      .toEqual(["ko cli.files: {where} cannot take every value the source allows"]);
  });

  it("reports a translation whose source changed after review", () => {
    expect(checkCatalogs(fixture({ en: { "cli.files": `${SOURCE}.` }, lock: { "cli.files": sha(SOURCE) } })))
      .toEqual(["ko cli.files: translation not reviewed against the current source (run --accept ko after review)"]);
  });

  it("reports keys outside their domain and tags that are not canonical", () => {
    expect(checkCatalogs(fixture({ en: { "server.files": SOURCE }, ko: { "server.files": "{where}에 파일 {count, number}개" }, lock: { "server.files": sha(SOURCE) } })))
      .toEqual(['en/cli.json server.files: key must start with "cli."']);
    expect(checkCatalogs(fixture({ catalog: { schemaVersion: "1.0.0", rootLocale: "en", locales: ["en", "KO"], domains: { cli: { sourceLocale: "en" } } } })))
      .toContain("locale KO: not a canonical BCP 47 tag");
  });

  it("ships a clean catalog and a fresh generated module", () => {
    expect(checkCatalogs(ROOT)).toEqual([]);
    expect(readFileSync(path.join(ROOT, GENERATED), "utf8")).toBe(renderGenerated(ROOT));
  });

  it("embeds each locale's catalog as ASCII JSON text that parses back to the locale files, non-ASCII and astral characters included", () => {
    const root = fixture({ ko: { "cli.files": "{where}에 파일 {count, number}개 😀 \"q\" \\ \n" } });
    const generated = renderGenerated(root);
    expect(generated).not.toMatch(/\P{ASCII}/u);
    const literal = /^ {2}"ko": (".*"),$/mu.exec(generated)[1];
    expect(JSON.parse(JSON.parse(literal))).toEqual(JSON.parse(readFileSync(path.join(root, "locales/ko/cli.json"), "utf8")));
  });

  it("embeds every shipped message of every locale", () => {
    const { catalog, messages } = loadCatalogs(ROOT);
    const generated = readFileSync(path.join(ROOT, GENERATED), "utf8");
    for (const locale of catalog.locales) {
      const literal = new RegExp(`^ {2}"${locale}": (".*"),$`, "mu").exec(generated)[1];
      const expected = Object.assign({}, ...Object.keys(catalog.domains).map((domain) => messages[locale][domain]));
      expect(JSON.parse(JSON.parse(literal))).toEqual(expected);
    }
  });
});
