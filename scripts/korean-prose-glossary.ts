import { readFile } from "node:fs/promises";
import { writeSync } from "node:fs";
import path from "node:path";
import { buildGlossaryWithRecovery } from "./korean-prose-glossary-build.js";
import { buildGlossaryDatabase, checkGlossaryDatabase, parseGlossarySeed } from "../mcp-server/src/korean-prose-glossary.js";
import { failureContext, producerFailureReason } from "../mcp-server/src/failure-diagnostics.js";

const root = path.resolve(import.meta.dirname, "..");
let phase: "input" | "build" | "check" | "output" = "input";
try {
  const arguments_ = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Arguments must be --name value pairs.");
    arguments_.set(key.slice(2), value);
  }
  const mode = arguments_.get("mode") ?? "check";
  const seedPath = path.resolve(root, arguments_.get("seed") ?? "skills/korean-prose-editor/resources/glossary.seed.jsonl");
  const databasePath = path.resolve(root, arguments_.get("db") ?? "skills/korean-prose-editor/resources/korean-prose-glossary.sqlite3");
  const entries = parseGlossarySeed(await readFile(seedPath, "utf8"));

  let metadata: ReturnType<typeof checkGlossaryDatabase>;
  if (mode === "build") {
    phase = "build";
    metadata = await buildGlossaryWithRecovery(databasePath, (temporaryPath) => {
      buildGlossaryDatabase(temporaryPath, entries, { id: "korean-prose-core", version: "1.2.1" });
      return checkGlossaryDatabase(temporaryPath, entries);
    });
  } else if (mode === "check") {
    phase = "check";
    metadata = checkGlossaryDatabase(databasePath, entries);
  } else {
    throw new Error("--mode must be build or check.");
  }

  phase = "output";
  const output = Buffer.from(JSON.stringify({ status: "ok", entries: entries.length, ...metadata }) + "\n", "utf8");
  if (writeSync(1, output) !== output.length) throw new Error("Glossary success output was incomplete.");
} catch (error) {
  // This script is the terminal error consumer. The library only preserves/throws.
  // The recovery wrapper owns this fixed code and an ordered array of actual errors.
  const recovery = error instanceof AggregateError
    && ["GLOSSARY_BUILD_FAILED", "GLOSSARY_CLEANUP_INCOMPLETE"].includes(
      (error as Error & { code?: string }).code ?? "") ? error : null;
  const first = recovery ? recovery.errors[0] : error;
  try {
    writeSync(2, JSON.stringify({
      component: "korean-prose-glossary", phase,
      reason: producerFailureReason(first) ?? (phase === "input" ? "GLOSSARY_INPUT_INVALID"
        : phase === "output" ? "GLOSSARY_OUTPUT_FAILED" : "GLOSSARY_UNAVAILABLE"),
      context: failureContext(first),
      ...(recovery ? {
        recoveryReason: (recovery as AggregateError & { code: string }).code,
        secondary: recovery.errors.slice(1).map(secondary => failureContext(secondary)),
      } : {}),
    }) + "\n");
  } catch { /* A failed stderr sink must not turn a failed command into success. */ }
  process.exitCode = 1;
}
