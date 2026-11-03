import { readFileSync } from "node:fs";
import { IntlMessageFormat } from "intl-messageformat";

import { CATALOGS, ROOT_LOCALE, SUPPORTED_LOCALES, type MessageParams, type SupportedLocale } from "./i18n-catalog.generated.js";
import { resolvePackageLocalePath, resolveUserSettingsPath } from "./runtime-config.js";

export { ROOT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale };
export type MessageKey = keyof MessageParams;

/** A message to show: the key and its params are the contract, the rendered text is display (docs/i18n-design.md 3). */
export interface MessageRef<K extends MessageKey = MessageKey> {
  readonly key: K;
  readonly params: MessageParams[K];
}

/** A key and params read back from storage or another AGS version; the key may be unknown to this catalog. */
export interface StoredMessageRef {
  readonly key: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export function msg<K extends MessageKey>(key: K, params: MessageParams[K]): MessageRef<K> {
  return { key, params };
}

/** MCP SEP-2792 request and response keys in `_meta` (docs/i18n-design.md 4.1 ②). */
export const ACCEPT_LANGUAGE_META = "io.modelcontextprotocol/acceptLanguage";
export const CONTENT_LANGUAGE_META = "io.modelcontextprotocol/contentLanguage";
export const LOCALE_ENVIRONMENT = "AGENT_GOVERNANCE_LOCALE";

const MAX_LANGUAGE_LIST_LENGTH = 256;
const MAX_LANGUAGE_RANGES = 16;
const WEIGHT = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/iu;

/**
 * Accept-Language syntax (RFC 9110 12.5.4) to canonical BCP 47 tags, highest weight first.
 * null when the value is unusable as a whole; callers then move to their next source.
 */
export function parseLanguageList(value: unknown): string[] | null {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_LANGUAGE_LIST_LENGTH) return null;
  const parts = value.split(",");
  if (parts.length > MAX_LANGUAGE_RANGES) return null;
  const ranges: Array<{ tag: string; weight: number; index: number }> = [];
  for (const [index, part] of parts.entries()) {
    const [range = "", ...parameters] = part.split(";").map(piece => piece.trim());
    let weight = 1;
    for (const parameter of parameters) {
      const match = WEIGHT.exec(parameter);
      if (!match?.[1]) return null;
      weight = Number(match[1]);
    }
    if (range === "*" || weight === 0) continue;
    let tag: string | undefined;
    try { [tag] = Intl.getCanonicalLocales(range); } catch { return null; }
    if (!tag) return null;
    ranges.push({ tag, weight, index });
  }
  return ranges.sort((left, right) => right.weight - left.weight || left.index - right.index).map(range => range.tag);
}

/** RFC 4647 3.4 Lookup: each range is shortened one subtag at a time (dropping a trailing singleton) until a shipped locale matches. */
export function lookupLocale(ranges: readonly string[]): SupportedLocale | null {
  for (const range of ranges) {
    const subtags = range.toLowerCase().split("-");
    while (subtags.length > 0) {
      const candidate = subtags.join("-");
      const match = SUPPORTED_LOCALES.find(locale => locale.toLowerCase() === candidate);
      if (match) return match;
      subtags.pop();
      if (subtags.at(-1)?.length === 1) subtags.pop();
    }
  }
  return null;
}

export type LocaleSource = "environment" | "settings" | "package" | "root";
export type LocaleSkipCode = "LOCALE_INVALID" | "LOCALE_UNSUPPORTED" | "LOCALE_SETTINGS_UNREADABLE";

export interface ResolvedLocale {
  readonly locale: SupportedLocale;
  readonly source: LocaleSource;
  /** Configured sources that were passed over, as codes for diagnostics. */
  readonly skipped: ReadonlyArray<{ readonly source: LocaleSource; readonly code: LocaleSkipCode }>;
}

export interface HostLocaleInputs {
  readonly environment?: NodeJS.ProcessEnv;
  /** null when the shared state directory cannot be resolved. */
  readonly settingsPath?: string | null;
  readonly packageLocalePath?: string;
  readonly readText?: (file: string) => string;
}

type Configured = { value: unknown } | { failure: LocaleSkipCode } | null;

function readLocaleFile(file: string | null, readText: (file: string) => string): Configured {
  if (file === null) return { failure: "LOCALE_SETTINGS_UNREADABLE" };
  let text: string;
  try {
    text = readText(file);
  } catch (cause) {
    // Not configured is not a failure; anything else (permissions, a directory) is reported.
    return (cause as NodeJS.ErrnoException).code === "ENOENT" ? null : { failure: "LOCALE_SETTINGS_UNREADABLE" };
  }
  try {
    const document: unknown = JSON.parse(text);
    if (document === null || typeof document !== "object" || !("locale" in document)) return null;
    return { value: (document as { locale: unknown }).locale };
  } catch {
    return { failure: "LOCALE_SETTINGS_UNREADABLE" };
  }
}

/** Host-side locale (docs/i18n-design.md 4.1 ①): environment, user settings, installed package, then the root locale. */
export function resolveHostLocale(inputs: HostLocaleInputs = {}): ResolvedLocale {
  const environment = inputs.environment ?? process.env;
  const readText = inputs.readText ?? ((file: string) => readFileSync(file, "utf8"));
  let settingsPath = inputs.settingsPath;
  if (settingsPath === undefined) {
    try { settingsPath = resolveUserSettingsPath(environment); } catch { settingsPath = null; }
  }
  const sources: Array<[LocaleSource, () => Configured]> = [
    ["environment", () => (environment[LOCALE_ENVIRONMENT] === undefined ? null : { value: environment[LOCALE_ENVIRONMENT] })],
    ["settings", () => readLocaleFile(settingsPath, readText)],
    ["package", () => readLocaleFile(inputs.packageLocalePath ?? resolvePackageLocalePath(), readText)],
  ];
  const skipped: Array<{ source: LocaleSource; code: LocaleSkipCode }> = [];
  for (const [source, read] of sources) {
    const configured = read();
    if (configured === null) continue;
    if ("failure" in configured) { skipped.push({ source, code: configured.failure }); continue; }
    const ranges = parseLanguageList(configured.value);
    if (!ranges) { skipped.push({ source, code: "LOCALE_INVALID" }); continue; }
    const locale = lookupLocale(ranges);
    if (!locale) { skipped.push({ source, code: "LOCALE_UNSUPPORTED" }); continue; }
    return { locale, source, skipped };
  }
  return { locale: ROOT_LOCALE, source: "root", skipped };
}

/** Service-side locale for one request (docs/i18n-design.md 4.1 ②): the request's `_meta` value, else the service default. */
export function resolveRequestLocale(meta: unknown, fallback: SupportedLocale): SupportedLocale {
  if (meta === null || typeof meta !== "object") return fallback;
  const ranges = parseLanguageList((meta as Record<string, unknown>)[ACCEPT_LANGUAGE_META]);
  return (ranges && lookupLocale(ranges)) ?? fallback;
}

// ponytail: compiled formatters are kept for the process; the bound is locales x catalog keys, not callers or params.
const formatters = new Map<string, IntlMessageFormat>();

function formatter(locale: SupportedLocale, key: string): IntlMessageFormat | null {
  const chain: readonly SupportedLocale[] = [locale, ROOT_LOCALE];
  for (const candidate of chain) {
    const id = `${candidate}\u0000${key}`;
    const cached = formatters.get(id);
    if (cached) return cached;
    const source = CATALOGS[candidate][key];
    if (source === undefined) continue;
    const compiled = new IntlMessageFormat(source, candidate, undefined, { ignoreTag: true });
    formatters.set(id, compiled);
    return compiled;
  }
  return null;
}

/** Renders in the locale, then the root locale; a key no catalog knows (another AGS version) renders as the key, never throws. */
export function render(ref: MessageRef | StoredMessageRef, locale: SupportedLocale): string {
  const compiled = formatter(locale, ref.key);
  if (!compiled) return ref.key;
  const output = compiled.format(ref.params as Record<string, string | number | Date>);
  return Array.isArray(output) ? output.join("") : String(output);
}

/** The wire form of a message: language-independent key and params, plus the display text and its locale. */
export function localized(ref: MessageRef | StoredMessageRef, locale: SupportedLocale): {
  messageKey: string; params: Readonly<Record<string, unknown>>; message: string; locale: SupportedLocale;
} {
  return { messageKey: ref.key, params: ref.params as Readonly<Record<string, unknown>>, message: render(ref, locale), locale };
}
