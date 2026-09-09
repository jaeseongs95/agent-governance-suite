import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "./lib.mjs";
import { findPython, runPython } from "./python-runner.mjs";

const python = findPython();
const testEntries = await readdir(path.join(ROOT, "tests"), { withFileTypes: true });
for (const entry of testEntries.filter((candidate) => candidate.isDirectory()).sort((left, right) => left.name.localeCompare(right.name))) {
  const script = path.join(ROOT, "tests", entry.name, "validate_skill.py");
  try {
    await access(script);
  } catch {
    continue;
  }
  runPython(python, script);
}
