import { afterEach, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { listNodeTestFiles } from "../../scripts/run-tests.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("collects nested Node-native files without collecting Vitest files or directories", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-node-collection-"));
  directories.push(directory);
  mkdirSync(path.join(directory, "nested"));
  mkdirSync(path.join(directory, "directory.node-test.mjs"));
  const nodeFile = path.join(directory, "nested", "actual.node-test.mjs");
  writeFileSync(nodeFile, "// synthetic Node-native suite", "utf8");
  writeFileSync(path.join(directory, "ordinary.test.mjs"), "// synthetic Vitest suite", "utf8");
  writeFileSync(path.join(directory, "backup.node-test.mjs.old"), "// not a test", "utf8");
  expect(listNodeTestFiles(directory)).toEqual([nodeFile]);
});

it("keeps missing collection input distinct from a genuinely empty directory", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-node-collection-"));
  directories.push(directory);
  expect(listNodeTestFiles(directory)).toEqual([]);
  expect(() => listNodeTestFiles(path.join(directory, "missing"))).toThrow();
});

it("does not traverse external or cyclic directory links", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-node-collection-"));
  const external = mkdtempSync(path.join(tmpdir(), "ags-node-external-"));
  directories.push(directory, external);
  mkdirSync(path.join(directory, "nested"));
  const legitFile = path.join(directory, "nested", "actual.node-test.mjs");
  writeFileSync(legitFile, "// legitimate suite", "utf8");
  writeFileSync(path.join(external, "outside.node-test.mjs"), "// external suite", "utf8");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(external, path.join(directory, "external"), linkType);
  symlinkSync(directory, path.join(directory, "nested", "cycle"), linkType);
  expect(listNodeTestFiles(directory)).toEqual([legitFile]);
});
