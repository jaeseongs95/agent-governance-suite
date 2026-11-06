// Judges the saved logs again with the current check.mjs: node rejudge.mjs <results.jsonl> <skillsFile> > results.rejudged.jsonl
// Use it after the judging rule was corrected from the smoke runs. The logs are untouched; only the `check` of each line is replaced.
import { existsSync, readFileSync } from "node:fs";
import { judgeRun, readKnownSkills } from "./check.mjs";

const [resultsFile, skillsFile] = process.argv.slice(2);
const known = readKnownSkills(skillsFile);
for (const line of readFileSync(resultsFile, "utf8").split("\n").filter(Boolean)) {
  const row = JSON.parse(line);
  if (row.runDir && existsSync(row.runDir)) row.check = judgeRun(row.host, row.runDir, known);
  process.stdout.write(JSON.stringify(row) + "\n");
}
