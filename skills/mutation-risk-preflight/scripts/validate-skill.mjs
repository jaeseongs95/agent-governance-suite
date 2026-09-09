#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ["SKILL.md", "agents/openai.yaml", "contracts/mutation-intent.v1.schema.json", "contracts/mutation-preflight-report.v1.schema.json", "contracts/upstream/task-envelope.v1.schema.json", "contracts/upstream/lock.json", "integration/skill-descriptor.json", "integration/provider-result.v1.schema.json"];
const errors = [];
for (const relative of required) try { await access(path.join(root, relative)); } catch { errors.push(`missing ${relative}`); }
const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
if (!/^---\n[\s\S]*?name: mutation-risk-preflight[\s\S]*?\n---/m.test(skill.replaceAll("\r\n", "\n"))) errors.push("SKILL.md frontmatter name mismatch");
for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(match[1])) try { await access(path.join(root, match[1])); } catch { errors.push(`broken link ${match[1]}`); }
for (const directory of ["contracts", "integration"]) for (const file of await readdir(path.join(root, directory))) if (file.endsWith(".json")) try { JSON.parse(await readFile(path.join(root, directory, file), "utf8")); } catch { errors.push(`invalid JSON ${directory}/${file}`); }
const lock = JSON.parse(await readFile(path.join(root, "contracts", "upstream", "lock.json"), "utf8"));
const snapshot = await readFile(path.join(root, lock.upstreams[0].snapshotPath));
const actual = createHash("sha256").update(snapshot).digest("hex");
if (lock.upstreams[0].sha256 !== actual) errors.push("TaskEnvelope.v1 snapshot checksum mismatch");
process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`);
process.exitCode = errors.length ? 1 : 0;
