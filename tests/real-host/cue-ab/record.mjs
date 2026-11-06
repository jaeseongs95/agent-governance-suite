// Appends one run to results.jsonl: node record.mjs <resultsFile> <host> <arm> <rep> <runTag> <runDir> <extraJson>
// The judge output (check.json) is stored as it is; this is the only place that knows the arm.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const [resultsFile, host, arm, rep, runTag, runDir, extra] = process.argv.slice(2);
const checkFile = path.join(runDir, "check.json");
let check = { error: "check.json missing" };
if (existsSync(checkFile)) {
  try { check = JSON.parse(readFileSync(checkFile, "utf8")); } catch { check = { error: "check.json unreadable" }; }
}
appendFileSync(resultsFile, JSON.stringify({ host, arm, rep: Number(rep), runTag, runDir, ...JSON.parse(extra || "{}"), check }) + "\n");
