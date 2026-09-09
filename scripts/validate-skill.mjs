import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { NAME_PATTERN, ROOT, parseArguments, readFrontmatter, readJson, walkFiles } from "./lib.mjs";

const PLACEHOLDER_PATTERN = /\[TODO:[^\]]*\]|\bTODO\b|\bTBD\b/u;
const LINK_PATTERN = /\[[^\]]+\]\((?!https?:|#|mailto:)([^)]+)\)/gu;

export async function validateSkill(name) {
  const errors = [];
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    return [`Invalid skill name: ${name}`];
  }

  const skillDirectory = path.join(ROOT, "skills", name);
  const skillFile = path.join(skillDirectory, "SKILL.md");
  let markdown;
  try {
    markdown = await readFile(skillFile, "utf8");
  } catch {
    return [`Missing skills/${name}/SKILL.md`];
  }

  try {
    const frontmatter = readFrontmatter(markdown);
    if (frontmatter.name !== name) {
      errors.push(`frontmatter name must equal ${name}`);
    }
    if (!frontmatter.description || frontmatter.description.length < 24) {
      errors.push("frontmatter description must be at least 24 characters");
    }
  } catch (error) {
    errors.push(error.message);
  }

  for (const match of markdown.matchAll(LINK_PATTERN)) {
    const target = match[1].split("#", 1)[0];
    if (!target) continue;
    try {
      await access(path.resolve(skillDirectory, decodeURIComponent(target)));
    } catch {
      errors.push(`broken relative link: ${match[1]}`);
    }
  }

  const files = await walkFiles(skillDirectory);
  for (const file of files.filter((candidate) => /\.(?:md|ya?ml|json|txt)$/u.test(candidate))) {
    const content = await readFile(file, "utf8");
    if (PLACEHOLDER_PATTERN.test(content)) {
      errors.push(`unfinished placeholder in ${path.relative(ROOT, file)}`);
    }
  }

  if (name !== "orchestrator") {
    const registry = await readJson(path.join(ROOT, "skills", "registry.json"));
    const descriptors = Array.isArray(registry) ? registry : registry.skills;
    const matches = descriptors.filter((descriptor) => descriptor.id === name);
    if (matches.length !== 1) {
      errors.push(`registry must contain exactly one descriptor for ${name}`);
    }
    try {
      await access(path.join(ROOT, "tests", name));
    } catch {
      errors.push(`missing tests/${name}`);
    }
  }

  return errors;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  if (!args.name) throw new Error("Usage: pnpm validate:skill --name <name>");
  const errors = await validateSkill(args.name);
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`${args.name}: valid`);
  }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(import.meta.filename)) {
  await main();
}
