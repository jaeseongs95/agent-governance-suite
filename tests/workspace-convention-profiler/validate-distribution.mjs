#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "workspace-convention-profiler");
const required = [
  "SKILL.md",
  "agents/openai.yaml",
  "contracts/workspace-profile-request.v1.schema.json",
  "contracts/workspace-convention-profile.v1.schema.json",
  "integration/skill-descriptor.json",
  "integration/provider-result.v1.schema.json"
];
const errors = [];

for (const relative of required) {
  try {
    await access(path.join(skillRoot, relative));
  } catch {
    errors.push(`missing ${relative}`);
  }
}

const skill = await readFile(path.join(skillRoot, "SKILL.md"), "utf8");
if (!/^---\n[\s\S]*?name: workspace-convention-profiler[\s\S]*?\n---/m.test(skill.replaceAll("\r\n", "\n"))) {
  errors.push("SKILL.md frontmatter name mismatch");
}
for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^https?:/u.test(match[1])) continue;
  try {
    await access(path.join(skillRoot, match[1]));
  } catch {
    errors.push(`broken link ${match[1]}`);
  }
}

const descriptor = JSON.parse(await readFile(path.join(skillRoot, "integration", "skill-descriptor.json"), "utf8"));
const version = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
if (!version || descriptor.providers.some((provider) => provider.skillId !== "workspace-convention-profiler" || provider.version !== version)) {
  errors.push("SKILL.md and descriptor versions must match");
}
for (const directory of ["contracts", "integration"]) {
  for (const file of await readdir(path.join(skillRoot, directory))) {
    if (!file.endsWith(".json")) continue;
    try {
      JSON.parse(await readFile(path.join(skillRoot, directory, file), "utf8"));
    } catch {
      errors.push(`invalid JSON ${directory}/${file}`);
    }
  }
}

process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`);
process.exitCode = errors.length ? 1 : 0;
