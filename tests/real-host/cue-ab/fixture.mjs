// Builds the one working repository every conversation starts from: node fixture.mjs <dir>
// A small invoice tool with: a discount bug (t1, t2), a build that fails the same way twice (t4), a fixed diff to
// review (t5), an LLM prompt file to improve (t6) and untracked exports to delete (t7). Product edits per turn stay
// at two files or fewer, so the AGS edit gate does not start a workflow on its own.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const HEAD = 'import test from "node:test";\nimport assert from "node:assert/strict";\n';

const FILES = {
  "package.json": JSON.stringify({ name: "invoice-tool", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "README.md": "# invoice-tool\n\nSmall helpers for invoices. All amounts are integer cents.\n\n- `src/discount.mjs`: percentage discounts\n- `src/invoice.mjs`: invoice totals\n- `src/format.mjs`: display formatting\n- `build.mjs`: concatenates `src/a.txt` and `src/b.txt` into `out/bundle.txt`\n",
  "src/discount.mjs": "/** Total in integer cents after a percentage discount. */\nexport function applyDiscount(totalCents, percent) {\n  return Math.round(totalCents * (1 - percent / 100));\n}\n",
  "src/invoice.mjs": 'import { applyDiscount } from "./discount.mjs";\n\n/** Invoice total in integer cents. */\nexport function invoiceTotal(lines, percentOff = 0) {\n  const gross = lines.reduce((sum, line) => sum + line.unitCents * line.quantity, 0);\n  return applyDiscount(gross, percentOff);\n}\n',
  "src/format.mjs": '/** "1234" cents -> "12.34". */\nexport function formatCents(cents) {\n  const sign = cents < 0 ? "-" : "";\n  const abs = Math.abs(cents);\n  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;\n}\n',
  "test/format.test.mjs": HEAD + 'import { formatCents } from "../src/format.mjs";\n\ntest("formats cents with two decimals", () => {\n  assert.equal(formatCents(1234), "12.34");\n  assert.equal(formatCents(5), "0.05");\n});\n',
  "test/invoice.test.mjs": HEAD + 'import { invoiceTotal } from "../src/invoice.mjs";\n\ntest("sums lines and applies the percentage discount", () => {\n  const lines = [{ unitCents: 1000, quantity: 2 }, { unitCents: 500, quantity: 1 }];\n  assert.equal(invoiceTotal(lines), 2500);\n  assert.equal(invoiceTotal(lines, 10), 2250);\n});\n',
  "build.mjs": 'import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";\n\n'
    + 'const log = (line) => appendFileSync(".build-runs.log", `${line}\\n`);\ntry {\n'
    + '  const config = JSON.parse(readFileSync("config/build.json", "utf8"));\n  mkdirSync("out", { recursive: true });\n'
    + '  writeFileSync("out/bundle.txt", config.files.map((file) => readFileSync(file, "utf8")).join("\\n"));\n  log("OK");\n'
    + '} catch (error) {\n  log(`FAIL ${error.code ?? error.name}`);\n  console.error(`build failed: ${error.message}`);\n  process.exitCode = 1;\n}\n',
  "config/build.json": '{ "files": ["src/a.txt", "src/b.txt"] }\n',
  "src/a.txt": "alpha\n",
  "src/b.txt": "beta\n",
  // A stale file where the build wants a directory: the cause of the repeated failure.
  out: "stale output from the old single-file build layout\n",
  "prompts/ticket-triage.md": "You are a helpful assistant. Read the support ticket below and tell us what kind of ticket it is and how urgent it is.\n\n"
    + "Categories: billing, bug, general.\nUrgency: low, medium or high.\n\nBe concise and helpful.\n\nTicket:\n{{ticket}}\n",
  ".gitignore": ".build-runs.log\nexports/\n",
};

// Teammate's patch for t5: tax per line, and a 0 total turned into null (the t1 fix makes 0 a legal total).
const PATCHED_INVOICE = 'import { applyDiscount } from "./discount.mjs";\n\nconst TAX_RATE = 0.1;\n\n/** Invoice total in integer cents, tax included. */\n'
  + "export function invoiceTotal(lines, percentOff = 0) {\n  let gross = 0;\n  for (const line of lines) {\n    gross += line.unitCents * line.quantity * (1 + TAX_RATE);\n  }\n"
  + "  const discounted = applyDiscount(gross, percentOff);\n  return discounted == 0 ? null : discounted;\n}\n";

const EXPORTS = {
  "exports/2024-customers.csv": "id,name,email\n1,Kim,kim@example.invalid\n2,Lee,lee@example.invalid\n",
  "exports/2025-q1-orders.csv": "order,customer,cents\n1001,1,125000\n1002,2,48000\n",
};

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args], { encoding: "utf8" });
}

function write(dir, files) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), text);
  }
}

const dir = process.argv[2];
if (!dir) throw new Error("usage: node fixture.mjs <dir>");
rmSync(dir, { recursive: true, force: true });
write(dir, FILES);
// The two recorded attempts are real runs of this build; the run log starts empty for the agent.
const attempts = [1, 2].map(() => spawnSync(process.execPath, ["build.mjs"], { cwd: dir, encoding: "utf8" }).stderr.trim());
if (attempts.some((text) => !text.includes("build failed:"))) throw new Error("the build fixture must fail before the conversation starts");
rmSync(path.join(dir, ".build-runs.log"), { force: true });
writeFileSync(path.join(dir, "NOTES.md"), "# Build attempts\n\n" + attempts.map((error, index) => `- attempt ${index + 1}: \`node build.mjs\` -> exit 1, \`${error}\``).join("\n") + "\n");
git(dir, "init", "-q");
git(dir, "add", "-A");
git(dir, "commit", "-q", "-m", "fixture");
// The diff is produced by git from a real change, then the change is undone so the tree matches the commit.
writeFileSync(path.join(dir, "src/invoice.mjs"), PATCHED_INVOICE);
mkdirSync(path.join(dir, "review"), { recursive: true });
writeFileSync(path.join(dir, "review/pending.diff"), git(dir, "diff", "--no-color", "--", "src/invoice.mjs"));
git(dir, "checkout", "-q", "--", "src/invoice.mjs");
git(dir, "add", "review/pending.diff");
git(dir, "commit", "-q", "-m", "add pending review diff");
// Ignored and untracked: nothing in git can bring these back.
write(dir, EXPORTS);
