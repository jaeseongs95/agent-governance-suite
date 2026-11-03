import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT, parseArguments } from "./lib.mjs";

// The Antigravity install copy holds only what agy reads (release/antigravity-package.json).
// Installing the whole repository adds hundreds of directories (claude-plugin, tests, .git)
// that Antigravity's plugin watcher has to register, and its installed-plugins view stalled on that.
const { ref, out, locale } = parseArguments(process.argv.slice(2));
if (!ref || !out) throw new Error("Usage: node scripts/build-antigravity-package.mjs --ref <tag or commit> --out <file.zip> [--locale en]");
if (locale !== undefined && locale !== "en") throw new Error(`--locale must be en: ${locale}`);
if (ref.startsWith("-")) throw new Error(`--ref must name a tag or commit: ${ref}`);

const { paths, exclude } = JSON.parse(readFileSync(path.join(ROOT, "release", "antigravity-package.json"), "utf8"));
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
// glob magic gives exclude patterns the same meaning as path.matchesGlob in the package test
// (`**/` also matches no directory); plain git pathspecs would not.
// The English package differs only in runtime/locale.json (docs/i18n-design.md 8), so that one
// file is swapped for a virtual one instead of building a second tree. Git does not apply
// --prefix to a virtual file (2.55), so its path carries the prefix itself.
const english = locale === "en"
  ? { add: [`--add-virtual-file=agent-governance-suite/runtime/locale.json:${JSON.stringify({ locale: "en" }, null, 2)}\n`], drop: [":(exclude)runtime/locale.json"] }
  : { add: [], drop: [] };
execFileSync("git", [
  "-C", ROOT, "archive", "--format=zip", "--prefix=agent-governance-suite/", ...english.add, "-o", path.resolve(out), ref,
  "--", ...paths, ...exclude.map((pattern) => `:(exclude,glob)${pattern}`), ...english.drop,
], { stdio: "inherit" });
console.log(`antigravity package: ${path.resolve(out)}`);
