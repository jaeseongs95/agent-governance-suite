import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function verifyUpgradeSource(source, expectedHead, expectedPin) {
  assert.match(expectedHead, /^[a-f0-9]{40}$/u);
  assert.match(expectedPin, /^[a-f0-9]{64}$/u);
  const manifestBytes = await readFile(source.manifestPath);
  assert.equal(hash(manifestBytes), expectedPin, "Externally verified whole-source manifest differs");
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.head, expectedHead);
  assert.equal(source.commit, expectedHead);
  assert.equal(source.tree, manifest.sourceTree);
  assert.match(manifest.sourceTree, /^[a-f0-9]{40}$/u);
  assert.equal(manifest.files, manifest.rows.length);
  assert.ok(manifest.files > 0);
  const seen = new Set();
  for (const row of manifest.rows) {
    assert.equal(typeof row.relativePath, "string");
    assert.ok(!row.relativePath.includes("\\") && !row.relativePath.includes(":") && !row.relativePath.startsWith("/"));
    assert.ok(row.relativePath.split("/").every(part => part && part !== "." && part !== ".."));
    assert.ok(!seen.has(row.relativePath.toLowerCase()));
    seen.add(row.relativePath.toLowerCase());
    const filename = path.join(source.directory, row.relativePath);
    assert.ok((await lstat(filename)).isFile());
    const bytes = await readFile(filename);
    assert.equal(bytes.length, row.bytes, "Source size differs: " + row.relativePath);
    assert.equal(hash(bytes), row.sha256, "Source bytes differ: " + row.relativePath);
  }
  for (const required of ["package.json", "pnpm-lock.yaml", "scripts/run-tests.mjs", "mcp-server/src/workflow-service.ts"]) assert.ok(seen.has(required));
  const pkg = JSON.parse(await readFile(path.join(source.directory, "package.json")));
  assert.equal(pkg.packageManager, "pnpm@11.19.0");
  assert.ok((await lstat(path.join(source.directory, "node_modules/tsx/dist/loader.mjs"))).isFile(), "Frozen dependencies required");
  assert.equal(hash(await readFile(path.join(source.directory, "mcp-server/src/workflow-service.ts"))), source.serviceSha256);
  return { head: expectedHead, tree: source.tree, files: manifest.files, manifestSha256: expectedPin };
}

async function main() {
  const [input, expectedCurrentHead, currentPin, oldPin] = process.argv.slice(2);
  assert.equal(process.versions.node.split(".")[0], "24");
  const inputPath = path.resolve(input);
  const inputs = JSON.parse(await readFile(inputPath));
  if (process.env.GITHUB_SHA !== undefined) assert.equal(expectedCurrentHead, process.env.GITHUB_SHA, "CI must consume actual triggering SHA");
  assert.equal(inputs.old.tree, "797ccf5960fea8fcebe16025d7786ca389ab6fbc");
  const old = await verifyUpgradeSource(inputs.old, "b3285616c896afdcbb298e3a08dffd612ddfa7b8", oldPin);
  assert.equal(old.files, 1733);
  const current = await verifyUpgradeSource(inputs.current, expectedCurrentHead, currentPin);
  console.log(JSON.stringify({ wholeSourceVerification: { old, current }, node: process.version }));
  process.env.AL06_D0040_UPGRADE_INPUT = inputPath;
  process.env.AL06_D0040_VERIFIED_CURRENT_HEAD = expectedCurrentHead;
  const { runTests } = await import(pathToFileURL(path.join(inputs.current.directory, "scripts/run-tests.mjs")));
  const loader = pathToFileURL(path.join(inputs.current.directory, "node_modules/tsx/dist/loader.mjs")).href;
  process.exitCode = await runTests(["--test-reporter=tap", path.join(import.meta.dirname, "d0040-genuine-legacy-upgrade.node-test.mjs")], [process.execPath, "--import", loader, "--test"]);
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
