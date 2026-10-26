import path from "node:path";
import { fileURLToPath } from "node:url";

/** Bundling several hooks gives their import.meta.url the same entry URL.
 * Match the intended entry name too, so imported CLIs cannot consume stdin. */
export function isHookEntry(url: string, name: string): boolean {
  const argument = process.argv[1];
  if (!argument || path.resolve(argument) !== fileURLToPath(url)) return false;
  const basename = path.basename(argument);
  return basename === `${name}.mjs` || basename === `${name}.ts`;
}
