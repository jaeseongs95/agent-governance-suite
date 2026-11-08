// Entry of runtime/i18n.mjs: the shared catalog for hook and script files that are not bundled (docs/contributing/i18n.md 6).
import { MODEL_LOCALE, msg, render } from "../mcp-server/src/i18n.ts";

export { MODEL_LOCALE, msg, render };

/** The locale of script and CLI output: MODEL_LOCALE, since an agent reads it (docs/contributing/i18n.md). */
export function hostLocale() {
  return MODEL_LOCALE;
}

/** A catalog message rendered for script and CLI output, in MODEL_LOCALE (docs/contributing/i18n.md). */
export function hostText(key, params = {}) {
  return render(msg(key, params), hostLocale());
}
