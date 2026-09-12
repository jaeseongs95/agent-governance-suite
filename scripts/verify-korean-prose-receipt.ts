import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const run = Number(args[0]);
const evaluationRoot = args[1] ? path.resolve(args[1]) : null;
if (![1, 2, 3].includes(run) || !evaluationRoot) throw new Error("usage: <run:1|2|3> <evaluation-root>");

const runDirectory = path.join(evaluationRoot, "evals", "runs", `run-${run}`);
const [inputText, candidateText, finalText, receiptText] = await Promise.all([
  readFile(path.join(evaluationRoot, "evals", "runs", "input.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "candidate.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "final.jsonl"), "utf8"),
  readFile(path.join(runDirectory, "workflow-receipt.json"), "utf8"),
]);
const receipt = JSON.parse(receiptText) as {
  runId: string;
  revision: number;
  stageResults: Array<{ output?: { output?: { actorId?: string; actorIds?: string[] } } }>;
};
if (receipt.revision !== 5 || receipt.stageResults.length !== 4) throw new Error("workflow receipt is not finalized after four stages");

const actors = receipt.stageResults.slice(0, 3).map((result) => result.output?.output?.actorId);
const finalActors = receipt.stageResults[3]?.output?.output?.actorIds;
if (actors.some((actor) => typeof actor !== "string") || new Set(actors).size !== 3 || JSON.stringify(actors) !== JSON.stringify(finalActors)) {
  throw new Error("workflow receipt actor binding is invalid");
}

const database = new DatabaseSync(path.join(runDirectory, "workflow.sqlite3"), { readOnly: true });
try {
  const row = database.prepare("SELECT receipt_json FROM workflow_runs WHERE run_id = ?").get(receipt.runId) as { receipt_json: string } | undefined;
  if (!row) throw new Error("persisted workflow receipt is missing");
  if (JSON.stringify(JSON.parse(row.receipt_json)) !== JSON.stringify(receipt)) throw new Error("SQLite and file receipts differ");

  const proseValues = new Set<string>();
  for (const record of [...parseJsonl(inputText), ...parseJsonl(candidateText), ...parseJsonl(finalText)]) {
    for (const field of ["sourceText", "candidateText", "finalText"]) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) proseValues.add(value);
    }
  }
  for (const prose of proseValues) {
    if (receiptText.includes(prose) || row.receipt_json.includes(prose)) throw new Error("raw prose leaked into a receipt surface");
  }
  console.log(`verified run ${run}: four stages, three actors, no raw prose in receipt or SQLite`);
} finally {
  database.close();
}

function parseJsonl(text: string): Array<Record<string, unknown>> {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}
