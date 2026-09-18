import { appendFile, readFile } from "node:fs/promises";

const reportPath = process.argv[2];
if (!reportPath) throw new Error("Usage: node scripts/prepare-upstream-matrix.mjs <report.json>");
const report = JSON.parse(await readFile(reportPath, "utf8"));
const matrix = report.auto.map((entry) => ({ skillId: entry.skillId, tag: entry.latestTag }));
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) await appendFile(githubOutput, `matrix=${JSON.stringify(matrix)}\n`, "utf8");
const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  const lines = ["## Upstream source report", "", `Automatic update candidates: ${matrix.length}`, ""];
  for (const entry of report.notify) {
    lines.push(`- notify-only: ${entry.skillId}: ${entry.error ?? `${entry.currentVersion} -> ${entry.latestVersion}`}`);
  }
  if (report.notify.length === 0) lines.push("- No notify-only changes.");
  for (const entry of report.attention ?? []) {
    lines.push(entry.error
      ? `- needs attention: ${entry.skillId}: ${entry.error}`
      : `- needs attention: ${entry.skillId}: pinned commit differs from ${entry.latestTag} at the same version; not updated automatically`);
  }
  await appendFile(summary, `${lines.join("\n")}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify(matrix)}\n`);
