#!/usr/bin/env node
// Message catalog checks and the generated key types (docs/contributing/i18n.md 5).
//   node scripts/i18n.mjs --write           regenerate mcp-server/src/i18n-catalog.generated.ts
//   node scripts/i18n.mjs --check           fail on catalog problems or a stale generated file
//   node scripts/i18n.mjs --accept <tag>    record the current source digests for <tag>'s translations (after review)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, TYPE } from "@formatjs/icu-messageformat-parser";

const ROOT = path.resolve(import.meta.dirname, "..");
export const GENERATED = "mcp-server/src/i18n-catalog.generated.ts";
const PARSE_OPTIONS = { ignoreTag: true };

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const digest = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/** Allowed value kinds per placeholder; a placeholder used twice keeps the kinds both uses accept. */
function placeholders(message) {
  const kinds = new Map();
  const add = (name, allowed) => {
    const previous = kinds.get(name);
    kinds.set(name, previous ? new Set([...previous].filter((kind) => allowed.includes(kind))) : new Set(allowed));
  };
  const walk = (elements) => {
    for (const element of elements) {
      // A plain argument also takes another catalog message ({key, params}), rendered in the same locale.
      if (element.type === TYPE.argument) add(element.value, ["string", "number", "message"]);
      else if (element.type === TYPE.number) add(element.value, ["number"]);
      else if (element.type === TYPE.date || element.type === TYPE.time) add(element.value, ["date", "number"]);
      else if (element.type === TYPE.select) add(element.value, ["string"]);
      else if (element.type === TYPE.plural) add(element.value, ["number"]);
      if (element.type === TYPE.select || element.type === TYPE.plural) {
        for (const option of Object.values(element.options)) walk(option.value);
      }
    }
  };
  walk(parse(message, PARSE_OPTIONS));
  return kinds;
}

export function loadCatalogs(root = ROOT) {
  const catalog = readJson(path.join(root, "locales", "catalog.json"));
  const messages = {};
  for (const locale of catalog.locales) {
    messages[locale] = {};
    for (const domain of Object.keys(catalog.domains)) {
      const file = path.join(root, "locales", locale, `${domain}.json`);
      messages[locale][domain] = existsSync(file) ? readJson(file) : null;
    }
  }
  const locks = Object.fromEntries(catalog.locales.map((locale) => {
    const file = path.join(root, "locales", locale, "translations.lock.json");
    return [locale, existsSync(file) ? readJson(file) : {}];
  }));
  return { catalog, messages, locks };
}

/** Every problem in the shipped catalogs; an empty list means they can ship. */
export function checkCatalogs(root = ROOT) {
  const { catalog, messages, locks } = loadCatalogs(root);
  const problems = [];
  for (const locale of [catalog.rootLocale, ...catalog.locales]) {
    let canonical;
    try { [canonical] = Intl.getCanonicalLocales(locale); } catch { canonical = null; }
    if (canonical !== locale) problems.push(`locale ${locale}: not a canonical BCP 47 tag`);
  }
  if (!catalog.locales.includes(catalog.rootLocale)) problems.push(`root locale ${catalog.rootLocale} is not shipped`);
  for (const [domain, { sourceLocale }] of Object.entries(catalog.domains)) {
    if (!catalog.locales.includes(sourceLocale)) { problems.push(`${domain}: source locale ${sourceLocale} is not shipped`); continue; }
    const source = messages[sourceLocale][domain];
    if (!source) { problems.push(`${sourceLocale}/${domain}.json: missing`); continue; }
    const sourceKinds = {};
    for (const [key, text] of Object.entries(source)) {
      if (!key.startsWith(`${domain}.`)) problems.push(`${sourceLocale}/${domain}.json ${key}: key must start with "${domain}."`);
      try { sourceKinds[key] = placeholders(text); } catch (cause) { problems.push(`${sourceLocale} ${key}: ${cause.message}`); }
    }
    for (const locale of catalog.locales.filter((tag) => tag !== sourceLocale)) {
      const translated = messages[locale][domain];
      if (!translated) { problems.push(`${locale}/${domain}.json: missing`); continue; }
      for (const key of Object.keys(source)) if (!(key in translated)) problems.push(`${locale} ${key}: missing translation`);
      for (const [key, text] of Object.entries(translated)) {
        if (!(key in source)) { problems.push(`${locale} ${key}: not in the ${sourceLocale} source`); continue; }
        let kinds;
        try { kinds = placeholders(text); } catch (cause) { problems.push(`${locale} ${key}: ${cause.message}`); continue; }
        const expected = sourceKinds[key];
        if (!expected) continue;
        const names = (map) => [...map.keys()].sort().join(",");
        if (names(kinds) !== names(expected)) {
          problems.push(`${locale} ${key}: placeholders {${names(kinds)}} differ from the source {${names(expected)}}`);
          continue;
        }
        for (const [name, allowed] of expected) {
          if (![...allowed].every((kind) => kinds.get(name).has(kind))) problems.push(`${locale} ${key}: {${name}} cannot take every value the source allows`);
        }
        if (locks[locale][key] !== digest(source[key])) problems.push(`${locale} ${key}: translation not reviewed against the current source (run --accept ${locale} after review)`);
      }
    }
  }
  return problems;
}

const TYPE_NAMES = { date: "Date", message: "NestedMessage" };
const typeOf = (allowed) => [...allowed].sort().map((kind) => TYPE_NAMES[kind] ?? kind).join(" | ") || "never";

/** The generated module: catalogs bundled from JSON and one params type per key, taken from the source locale. */
export function renderGenerated(root = ROOT) {
  const { catalog, messages } = loadCatalogs(root);
  const ident = (locale, domain) => `${locale.replace(/-/gu, "_")}_${domain.replace(/[^A-Za-z0-9]/gu, "_")}`;
  const lines = ["// Generated by scripts/i18n.mjs from locales/. Do not edit.", ""];
  for (const locale of catalog.locales) {
    for (const domain of Object.keys(catalog.domains)) {
      lines.push(`import ${ident(locale, domain)} from "../../locales/${locale}/${domain}.json" with { type: "json" };`);
    }
  }
  lines.push("", `export const SUPPORTED_LOCALES = ${JSON.stringify(catalog.locales)} as const;`);
  lines.push("export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];");
  lines.push(`export const ROOT_LOCALE: SupportedLocale = ${JSON.stringify(catalog.rootLocale)};`, "");
  lines.push("/** Another catalog message as a placeholder value; it is rendered in the same locale. */");
  lines.push("export interface NestedMessage { readonly key: string; readonly params: Readonly<Record<string, unknown>> }", "");
  lines.push("export const CATALOGS: Readonly<Record<SupportedLocale, Readonly<Record<string, string>>>> = {");
  for (const locale of catalog.locales) {
    lines.push(`  ${JSON.stringify(locale)}: { ${Object.keys(catalog.domains).map((domain) => `...${ident(locale, domain)}`).join(", ")} },`);
  }
  lines.push("};", "", "export interface MessageParams {");
  for (const [domain, { sourceLocale }] of Object.entries(catalog.domains)) {
    for (const [key, text] of Object.entries(messages[sourceLocale][domain] ?? {})) {
      const fields = [...placeholders(text)].map(([name, allowed]) => `${JSON.stringify(name)}: ${typeOf(allowed)}`);
      lines.push(`  ${JSON.stringify(key)}: { ${fields.join("; ")}${fields.length ? ";" : ""} };`);
    }
  }
  lines.push("}", "");
  return lines.join("\n").replace(/\{ {2}\}/gu, "Record<string, never>");
}

function accept(root, locale) {
  const { catalog, messages, locks } = loadCatalogs(root);
  if (!catalog.locales.includes(locale)) throw new Error(`${locale} is not a shipped locale.`);
  const lock = { ...locks[locale] };
  for (const [domain, { sourceLocale }] of Object.entries(catalog.domains)) {
    if (sourceLocale === locale) continue;
    for (const key of Object.keys(messages[locale][domain] ?? {})) {
      const source = messages[sourceLocale][domain]?.[key];
      if (source !== undefined) lock[key] = digest(source);
    }
  }
  const sorted = Object.fromEntries(Object.entries(lock).sort(([a], [b]) => (a < b ? -1 : 1)));
  writeFileSync(path.join(root, "locales", locale, "translations.lock.json"), `${JSON.stringify(sorted, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [mode, value] = process.argv.slice(2);
  if (mode === "--write") {
    writeFileSync(path.join(ROOT, GENERATED), renderGenerated());
  } else if (mode === "--accept" && value) {
    accept(ROOT, value);
  } else if (mode === "--check") {
    const problems = checkCatalogs();
    if (readFileSync(path.join(ROOT, GENERATED), "utf8") !== renderGenerated()) problems.push(`${GENERATED}: stale (run node scripts/i18n.mjs --write)`);
    for (const problem of problems) console.error(problem);
    process.exitCode = problems.length > 0 ? 1 : 0;
  } else {
    console.error("usage: node scripts/i18n.mjs --write | --check | --accept <locale>");
    process.exitCode = 2;
  }
}
