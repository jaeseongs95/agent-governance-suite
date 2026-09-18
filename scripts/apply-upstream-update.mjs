import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ROOT, readJson } from "./lib.mjs";
import { discoverUpstreamUpdates } from "./source-lock.mjs";

const skillId = process.argv[2];
const requestedTag = process.argv[3];
if (!skillId || !requestedTag) throw new Error("Usage: node scripts/apply-upstream-update.mjs <skill-id> <tag>");

const lock = await readJson(path.join(ROOT, "skills", "source-lock.json"));
const source = lock.sources.find((entry) => entry.skillId === skillId);
if (!source || source.updatePolicy !== "auto-pr" || source.downstreamModifications.length > 0) {
  throw new Error(`${skillId} is not eligible for an automatic update`);
}
const update = (await discoverUpstreamUpdates()).find((entry) => entry.skillId === skillId);
if (!update?.updateAvailable || update.latestTag !== requestedTag || !update.latestCommit) {
  throw new Error(`${requestedTag} is not the current stable update for ${skillId}`);
}

execFileSync(process.execPath, [
  path.join(ROOT, "scripts", "import-skill.mjs"),
  "--source", source.source,
  "--ref", update.latestTag,
  "--skill-path", source.sourcePath,
  "--replace", "true",
], { cwd: ROOT, stdio: "inherit" });

for (const readme of ["README.md", "README.en.md"]) {
  const target = path.join(ROOT, readme);
  const lines = (await readFile(target, "utf8")).split(/(?<=\n)/u);
  const matching = lines.filter((line) => line.startsWith("|") && line.includes(`\`${skillId}\``));
  if (matching.length !== 1) throw new Error(`${readme} must contain exactly one table row for ${skillId}`);
  const index = lines.indexOf(matching[0]);
  const cells = matching[0].split("|");
  if (cells.length < 6) throw new Error(`${readme} skill row has an unexpected shape for ${skillId}`);
  cells[2] = cells[2].replace(/\/tree\/(?:v\d+\.\d+\.\d+|[a-f0-9]{40})/u, `/tree/${update.latestTag}`);
  cells[3] = ` ${update.latestVersion} `;
  lines[index] = cells.join("|");
  await writeFile(target, lines.join(""), "utf8");
}

console.log(`updated ${skillId} to ${update.latestTag}@${update.latestCommit}`);
