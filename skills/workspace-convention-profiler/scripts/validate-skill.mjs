#!/usr/bin/env node
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const required = ["SKILL.md", "agents/openai.yaml", "contracts/workspace-profile-request.v1.schema.json", "contracts/workspace-convention-profile.v1.schema.json", "integration/skill-descriptor.json", "integration/provider-result.v1.schema.json"];
const errors = [];
for (const relative of required) try { await access(path.join(root, relative)); } catch { errors.push(`missing ${relative}`); }
const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
if (!/^---\n[\s\S]*?name: workspace-convention-profiler[\s\S]*?\n---/m.test(skill.replaceAll("\r\n", "\n"))) errors.push("SKILL.md frontmatter name mismatch");
const packageDocument = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const descriptorDocument = JSON.parse(await readFile(path.join(root, "integration", "skill-descriptor.json"), "utf8"));
const skillVersion = skill.match(/^\s*version:\s*["']?([^"'\s]+)["']?\s*$/m)?.[1];
if (!skillVersion || skillVersion !== packageDocument.version || descriptorDocument.providers.some((provider) => provider.version !== packageDocument.version)) errors.push("package, SKILL.md and descriptor versions must match");
for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(match[1])) try { await access(path.join(root, match[1])); } catch { errors.push(`broken link ${match[1]}`); }
for (const file of await readdir(path.join(root, "contracts"))) if (file.endsWith(".json")) try { JSON.parse(await readFile(path.join(root, "contracts", file), "utf8")); } catch { errors.push(`invalid JSON contracts/${file}`); }
for (const file of ["integration/skill-descriptor.json", "integration/provider-result.v1.schema.json"]) try { JSON.parse(await readFile(path.join(root, file), "utf8")); } catch { errors.push(`invalid JSON ${file}`); }
process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`);
process.exitCode = errors.length ? 1 : 0;
