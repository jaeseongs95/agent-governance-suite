import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

import { buildGlossaryDatabase, checkGlossaryDatabase, parseGlossarySeed } from "../mcp-server/src/korean-prose-glossary.js";

const root = path.resolve(import.meta.dirname, "..");
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

if (mode === "build") {
  await mkdir(path.dirname(databasePath), { recursive: true });
  const temporaryPath = `${databasePath}.building`;
  await rm(temporaryPath, { force: true });
  try {
    buildGlossaryDatabase(temporaryPath, entries, { id: "korean-prose-core", version: "1.2.1" });
    checkGlossaryDatabase(temporaryPath, entries);
    await rm(databasePath, { force: true });
    await rename(temporaryPath, databasePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
} else if (mode !== "check") {
  throw new Error("--mode must be build or check.");
}

const metadata = checkGlossaryDatabase(databasePath, entries);
process.stdout.write(`${JSON.stringify({ status: "ok", entries: entries.length, ...metadata })}\n`);
