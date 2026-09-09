import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compileAllSchemas } from "./schema-validation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "SKILL.md", "agents/openai.yaml", "README.md", "LICENSE",
  "contracts/failure-episode-set.v1.schema.json", "contracts/diagnosis-report.v1.schema.json",
  "integration/skill-descriptor.json", "integration/provider-result.v1.schema.json"
];
const errors = [];
try { compileAllSchemas(); } catch (error) { errors.push(`schema compile failed: ${error.message}`); }
for (const relative of required) {
  try { await access(path.join(root, relative)); } catch { errors.push(`missing ${relative}`); }
}
for (const relative of required.filter((item) => item.endsWith(".json"))) {
  try { JSON.parse(await readFile(path.join(root, relative), "utf8")); } catch (error) { errors.push(`invalid JSON ${relative}: ${error.message}`); }
}
try {
  const skill = await readFile(path.join(root, "SKILL.md"), "utf8");
  if (!skill.startsWith("---\nname: blocker-diagnostician\n")) errors.push("SKILL.md name does not match repository name");
  const scripts = await Promise.all(["core.mjs", "cli.mjs", "cluster-failures.mjs", "digest-request.mjs", "validate-report.mjs", "schema-validation.mjs"].map((name) => readFile(path.join(root, "scripts", name), "utf8")));
  if (scripts.some((content) => content.includes("스킬통합플러그인") || content.includes("agent-governance-suite/"))) errors.push("runtime scripts must not import the suite");
} catch (error) {
  errors.push(error.message);
}
if (errors.length) {
  console.error(errors.map((item) => `- ${item}`).join("\n"));
  process.exitCode = 1;
} else console.log("repository: valid");
