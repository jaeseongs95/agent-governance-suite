import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ROOT, parseArguments } from "./lib.mjs";

// The Antigravity install copy holds only what agy reads (release/antigravity-package.json).
// Installing the whole repository adds hundreds of directories (claude-plugin, tests, .git)
// that Antigravity's plugin watcher has to register, and its installed-plugins view stalled on that.
const { ref, out } = parseArguments(process.argv.slice(2));
if (!ref || !out) throw new Error("Usage: node scripts/build-antigravity-package.mjs --ref <tag or commit> --out <file.zip>");

const { paths, exclude } = JSON.parse(readFileSync(path.join(ROOT, "release", "antigravity-package.json"), "utf8"));
mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
execFileSync("git", [
  "-C", ROOT, "archive", "--format=zip", "--prefix=agent-governance-suite/", "-o", path.resolve(out), ref,
  "--", ...paths, ...exclude.map((pattern) => `:(exclude)${pattern}`),
], { stdio: "inherit" });
console.log(`antigravity package: ${path.resolve(out)}`);
