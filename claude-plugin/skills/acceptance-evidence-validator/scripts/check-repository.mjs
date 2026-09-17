import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compileAllSchemas } from "./schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md", "agents/openai.yaml", "README.md", "LICENSE",
  "contracts/acceptance-evidence-input.v1.schema.json",
  "contracts/acceptance-evidence-report.v1.schema.json",
  "contracts/acceptance-report-validation.v1.schema.json",
  "contracts/upstream/task-envelope.v1.schema.json", "contracts/upstream/lock.json",
  "integration/skill-descriptor.json", "integration/provider-result.v1.schema.json"
];
const errors = [];
for (const relative of required) {
  try { await access(path.join(root, relative)); } catch { errors.push(`missing ${relative}`); }
}
for (const relative of required.filter((item) => item.endsWith(".json"))) {
  try { JSON.parse(await readFile(path.join(root, relative), "utf8")); } catch (error) { errors.push(`invalid JSON ${relative}: ${error.message}`); }
}
try {
  compileAllSchemas();
  const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
  if (!skill.startsWith("---\nname: acceptance-evidence-validator\n")) errors.push("SKILL.md name does not match repository name");
  const scripts = await Promise.all(["core.mjs", "cli.mjs", "validate-report.mjs", "schema-validation.mjs"].map((name) => readFile(path.join(root, "scripts", name), "utf8")));
  if (scripts.some((content) => content.includes("스킬통합플러그인") || content.includes("agent-governance-suite/"))) errors.push("runtime scripts must not import the suite");
  const lock = JSON.parse(await readFile(path.join(root, "contracts/upstream/lock.json"), "utf8"));
  const snapshot = await readFile(path.join(root, "contracts/upstream/task-envelope.v1.schema.json"));
  const actual = `sha256:${createHash("sha256").update(snapshot).digest("hex")}`;
  if (lock.files?.[0]?.sha256 !== actual) errors.push("vendored TaskEnvelope checksum does not match lock.json");
} catch (error) {
  errors.push(error.message);
}
if (errors.length) {
  console.error(errors.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else console.log("repository: valid");
