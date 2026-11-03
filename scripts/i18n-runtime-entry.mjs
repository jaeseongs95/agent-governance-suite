// Entry of runtime/i18n.mjs: the shared catalog for hook and script files that are not bundled (docs/i18n-design.md 6).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOCALE_ENVIRONMENT, msg, render, resolveHostLocale as resolveLocale } from "../mcp-server/src/i18n.ts";

export { msg, render };

/**
 * As runtime/i18n.mjs the package locale sits beside this file. A bundle that inlines this module elsewhere (a skill
 * script imported by mcp-server/dist) keeps the server default path, which is relative to mcp-server/dist.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const packageLocalePath = path.basename(here) === "runtime" ? path.join(here, "locale.json") : undefined;

export function resolveHostLocale(inputs = {}) {
  return resolveLocale({ ...(packageLocalePath ? { packageLocalePath } : {}), ...inputs });
}

let resolved = null;

/** The host locale of this process; resolved again only when the environment value changes (tests switch it in-process). */
export function hostLocale() {
  const environment = process.env[LOCALE_ENVIRONMENT];
  if (!resolved || resolved.environment !== environment) resolved = { environment, locale: resolveHostLocale().locale };
  return resolved.locale;
}

/** A catalog message rendered in the host locale: script and CLI output (docs/i18n-design.md 6). */
export function hostText(key, params = {}) {
  return render(msg(key, params), hostLocale());
}
