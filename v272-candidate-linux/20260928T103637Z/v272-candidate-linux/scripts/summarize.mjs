// summarize vitest JSON: counts + full names of failed/skipped tests
import fs from "node:fs";
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  const fails = [], skips = [];
  for (const r of j.testResults) for (const a of r.assertionResults) {
    const n = `${r.name.replace(/^.*?\/tests\//, "tests/")} > ${a.fullName}`;
    if (a.status === "failed") fails.push(n + "\n      " + (a.failureMessages?.[0] ?? "").split("\n").slice(0, 3).join(" | "));
    else if (a.status !== "passed") skips.push(`${n} [${a.status}]`);
  }
  const failedFiles = j.testResults.filter((r) => r.status !== "passed").map((r) => `${r.name.replace(/^.*?\/tests\//, "tests/")} [${r.status}] ${r.assertionResults.length ? "" : (r.message ?? "").slice(0, 300)}`);
  console.log(`${f}: files=${j.numTotalTestSuites} failedFiles=${j.numFailedTestSuites} tests=${j.numTotalTests} pass=${j.numPassedTests} fail=${j.numFailedTests} skip/pending=${j.numPendingTests + (j.numTodoTests ?? 0)} success=${j.success}`);
  console.log("  FAILED:"); fails.forEach((x) => console.log("   - " + x));
  console.log("  SKIPPED:"); skips.forEach((x) => console.log("   - " + x));
  console.log("  NON-PASSED FILES:"); failedFiles.forEach((x) => console.log("   - " + x));
}
