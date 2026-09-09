import { accessSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ROOT } from "./lib.mjs";
import { findPython, runPython } from "./python-runner.mjs";

const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"));
const pluginValidator = path.join(codexHome, "skills", ".system", "plugin-creator", "scripts", "validate_plugin.py");
const skillValidator = path.join(codexHome, "skills", ".system", "skill-creator", "scripts", "quick_validate.py");
accessSync(pluginValidator);
accessSync(skillValidator);

const python = findPython();
runPython(python, pluginValidator, [ROOT]);
const skillDirectories = readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
for (const skill of skillDirectories) {
  runPython(python, skillValidator, [path.join(ROOT, "skills", skill)]);
}
