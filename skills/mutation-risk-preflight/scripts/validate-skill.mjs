#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// The skill folder is distributable on its own (no runtime/ beside it): without runtime/i18n.mjs a diagnostic prints its catalog key and parameters.
const i18nUrl = new URL("../../../runtime/i18n.mjs", import.meta.url);
const hostText = existsSync(fileURLToPath(i18nUrl)) ? (await import(i18nUrl.href)).hostText : (key, params = {}) => `${key} ${JSON.stringify(params)}`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = ["SKILL.md", "agents/openai.yaml", "contracts/mutation-intent.v1.schema.json", "contracts/mutation-preflight-report.v1.schema.json", "contracts/upstream/task-envelope.v1.schema.json", "contracts/upstream/lock.json", "integration/skill-descriptor.json", "integration/provider-result.v1.schema.json"];
const errors = [];
const code = (error) => error?.code ?? error?.name ?? "UNKNOWN";
for (const relative of required) try { await access(path.join(root, relative)); } catch (error) { errors.push(error.code === "ENOENT" ? hostText("skillChecks.mutationRiskPreflightSkill.missingFile", { relative }) : hostText("skillChecks.mutationRiskPreflightSkill.cannotAccessFile", { relative, code: code(error) })); }
const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
if (!/^---\n[\s\S]*?name: mutation-risk-preflight[\s\S]*?\n---/m.test(skill.replaceAll("\r\n", "\n"))) errors.push(hostText("skillChecks.mutationRiskPreflightSkill.frontmatterNameMismatch"));
for (const match of skill.matchAll(/\]\(([^)]+)\)/g)) if (!/^https?:/.test(match[1])) try { await access(path.join(root, match[1])); } catch (error) { errors.push(error.code === "ENOENT" ? hostText("skillChecks.mutationRiskPreflightSkill.brokenLink", { link: match[1] }) : hostText("skillChecks.mutationRiskPreflightSkill.cannotAccessLink", { link: match[1], code: code(error) })); }
for (const directory of ["contracts", "integration"]) for (const file of await readdir(path.join(root, directory))) if (file.endsWith(".json")) try { JSON.parse(await readFile(path.join(root, directory, file), "utf8")); } catch (error) { errors.push(error instanceof SyntaxError ? hostText("skillChecks.mutationRiskPreflightSkill.invalidJson", { directory, file }) : hostText("skillChecks.mutationRiskPreflightSkill.cannotReadJson", { directory, file, code: code(error) })); }
const lock = JSON.parse(await readFile(path.join(root, "contracts", "upstream", "lock.json"), "utf8"));
const snapshot = await readFile(path.join(root, lock.upstreams[0].snapshotPath));
const actual = createHash("sha256").update(snapshot).digest("hex");
if (lock.upstreams[0].sha256 !== actual) errors.push(hostText("skillChecks.mutationRiskPreflightSkill.snapshotChecksumMismatch"));
process.stdout.write(`${JSON.stringify({ valid: errors.length === 0, errors }, null, 2)}\n`);
process.exitCode = errors.length ? 1 : 0;
