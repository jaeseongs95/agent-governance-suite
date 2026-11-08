import { IntlMessageFormat } from "intl-messageformat";

import { CATALOG_TEXT, ROOT_LOCALE, SUPPORTED_LOCALES, type MessageParams, type SupportedLocale } from "./i18n-catalog.generated.js";

export { ROOT_LOCALE, SUPPORTED_LOCALES, type SupportedLocale };
export type MessageKey = keyof MessageParams;

/** A message to show: the key and its params are the contract, the rendered text is display (docs/contributing/i18n.md 3). */
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

// Every hook is a new process, and building the catalogs as object literals took about a fifth of a hook's run
// (T-0033, 2026-11-08: 104 ms against 82 ms without them), so a catalog is parsed when a message of its locale is first needed.
const parsedCatalogs = new Map<SupportedLocale, Readonly<Record<string, string>>>();

function catalog(locale: SupportedLocale): Readonly<Record<string, string>> {
  let parsed = parsedCatalogs.get(locale);
  if (!parsed) {
    parsed = JSON.parse(CATALOG_TEXT[locale]) as Readonly<Record<string, string>>;
    parsedCatalogs.set(locale, parsed);
  }
  return parsed;
}

/** Whether this catalog can render a key reported by another process (e.g. a skill CLI) in any locale. */
export function isCatalogKey(key: string): boolean {
  return Object.hasOwn(catalog(ROOT_LOCALE), key);
}

/** MCP SEP-2792 response key in `_meta`: the language of the returned text, always MODEL_LOCALE. */
export const CONTENT_LANGUAGE_META = "io.modelcontextprotocol/contentLanguage";

/**
 * Everything AGS renders is read by a model first — hook context, the MCP server instructions, tool descriptions and
 * results, skill and hook CLI output — so it is rendered in this one locale, whatever the host, request or package
 * locale. Every session pays for that text in tokens: the same 1,521 catalog messages took 31,909 o200k tokens in Korean
 * and 22,757 in English (2026-11-08). User decisions 2026-11-08: model-facing text needs no translation, only the
 * cheapest form; the English packages and the admin page's display locale are removed with the locale chain.
 * The agent writes what the user reads in the user's language itself.
 */
export const MODEL_LOCALE: SupportedLocale = "en";

// ceiling: compiled formatters are kept for the process; the bound is locales x catalog keys, not callers or params.
const formatters = new Map<string, IntlMessageFormat>();

function formatter(locale: SupportedLocale, key: string): IntlMessageFormat | null {
  const chain: readonly SupportedLocale[] = [locale, ROOT_LOCALE];
  for (const candidate of chain) {
    const id = `${candidate}\u0000${key}`;
    const cached = formatters.get(id);
    if (cached) return cached;
    const source = catalog(candidate)[key];
    if (source === undefined) continue;
    const compiled = new IntlMessageFormat(source, candidate, undefined, { ignoreTag: true });
    formatters.set(id, compiled);
    return compiled;
  }
  return null;
}

function isNestedMessage(value: unknown): value is StoredMessageRef {
  return value !== null && typeof value === "object" && !(value instanceof Date)
    && typeof (value as { key?: unknown }).key === "string"
    && (value as { params?: unknown }).params !== null && typeof (value as { params?: unknown }).params === "object";
}

/**
 * Renders in the locale, then the root locale; a key no catalog knows (another AGS version) renders as the key, never throws.
 * A param that is itself a message ({key, params}, e.g. a rejection's cause) is rendered in the same locale first.
 */
export function render(ref: MessageRef | StoredMessageRef, locale: SupportedLocale): string {
  const compiled = formatter(locale, ref.key);
  if (!compiled) return ref.key;
  const params = Object.fromEntries(Object.entries(ref.params as Record<string, unknown>)
    .map(([name, value]) => [name, isNestedMessage(value) ? render(value, locale) : value]));
  const output = compiled.format(params as Record<string, string | number | Date>);
  return Array.isArray(output) ? output.join("") : String(output);
}

/** The wire form of a message: language-independent key and params, plus the display text and its locale. */
export function localized(ref: MessageRef | StoredMessageRef, locale: SupportedLocale): {
  messageKey: string; params: Readonly<Record<string, unknown>>; message: string; locale: SupportedLocale;
} {
  return { messageKey: ref.key, params: ref.params as Readonly<Record<string, unknown>>, message: render(ref, locale), locale };
}
