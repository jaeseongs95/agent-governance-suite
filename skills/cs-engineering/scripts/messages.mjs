import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Messages come from the AGS runtime when this skill sits beside it (repository, plugin or zip layout). A skill
// folder copied alone (clean-room installation) has no catalog, so it prints the message key and its parameters.
// An existing but broken runtime must NOT silently fall back: it is imported without a guard and its failure surfaces.
const agsI18n = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runtime/i18n.mjs');
const render = existsSync(agsI18n) ? (await import(pathToFileURL(agsI18n).href)).hostText : null;

export function hostText(key, params = {}) {
  if (render) return render(key, params);
  return Object.keys(params).length ? `${key} ${JSON.stringify(params)}` : key;
}
