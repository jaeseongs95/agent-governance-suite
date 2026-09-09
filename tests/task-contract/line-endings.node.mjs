import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const skillRoot = path.resolve(testsRoot, "..", "..", "skills", "task-contract");
const textExtensions = new Set([".json", ".md", ".mjs", ".yaml", ".yml"]);

async function textFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await textFiles(filename));
    else if (textExtensions.has(path.extname(entry.name)) || entry.name === ".gitattributes") result.push(filename);
  }
  return result;
}

test("task-contract text assets use LF line endings", async () => {
  for (const root of [skillRoot, testsRoot]) {
    for (const filename of await textFiles(root)) {
      assert.equal((await readFile(filename)).includes(Buffer.from("\r\n")), false, filename);
    }
  }
});
