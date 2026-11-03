// Entry of runtime/i18n.mjs: the shared catalog for hook and script files that are not bundled (docs/i18n-design.md 6).
import { fileURLToPath } from "node:url";

import { msg, render, resolveHostLocale as resolveLocale } from "../mcp-server/src/i18n.ts";

export { msg, render };

/** The bundle sits in runtime/ beside the package's locale.json; the server default path is relative to mcp-server/dist. */
export function resolveHostLocale(inputs = {}) {
  return resolveLocale({ packageLocalePath: fileURLToPath(new URL("./locale.json", import.meta.url)), ...inputs });
}
