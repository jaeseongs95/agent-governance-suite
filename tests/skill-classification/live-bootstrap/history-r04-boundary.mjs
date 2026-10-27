import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {cp, mkdir, readFile} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createSourceScratch, prepareSourceScratch, removeSourceScratch} from "./source-scratch.mjs";

// The current helper operates on a frozen historical input, in a test-owned tree.
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const history = path.join(repo, "tests/skill-classification/live-bootstrap/history-r04");
const archive = path.join(history, "frozen-input.tar.gz");
const budgetMode = process.argv.includes("--budget");
const archiveBytes = await readFile(archive);
assert.equal(createHash("sha256").update(archiveBytes).digest("hex"),
  "e8981a1534b06d8638c018b9cd360b563dd1d177ef04d03c5e345209af14260c", "history-r04 archive");
const parentOwnsRoot = process.argv[4] !== undefined && process.argv[4] !== "--budget";
const temporary = parentOwnsRoot ? path.resolve(process.argv[4]) : createSourceScratch(repo);
try {
  prepareSourceScratch(repo, temporary);
  const childTemp = path.join(temporary, "children");
  await mkdir(childTemp);
  await cp(path.join(repo, "mcp-server/src"), path.join(temporary, "mcp-server/src"), {recursive: true});
  await mkdir(path.join(temporary, "tests/skill-classification"), {recursive: true});
  await cp(path.join(repo, "tests/skill-classification/evaluation.ts"), path.join(temporary, "tests/skill-classification/evaluation.ts"));
  // All historical inventory sources, membership, corpus and oracles come from
  // the verified 521aa Git snapshot; current source changes cannot rewrite it.
  const unpack = spawnSync("tar", ["-xzf", archive, "-C", temporary], {encoding: "utf8", timeout: 30000});
  assert.equal(unpack.error, undefined);
  assert.equal(unpack.status, 0, `history-r04 extract: ${unpack.stderr}`);
  const copied = path.join(temporary, "tests/skill-classification/live-bootstrap");
  if (budgetMode) {
    const original = await readFile(path.join(history, "budget-regression.mts"));
    assert.equal(createHash("sha256").update(original).digest("hex"), "e91a7828e2e22f116dbeea2763a2099e4a06327a77ea37e1fac9d4ccb0dd9d5d", "history-r04 budget test");
    await cp(path.join(history, "budget-regression.mts"), path.join(copied, "budget-regression.mts"));
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(copied, budgetMode ? "budget-regression.mts" : "precision-regression.mts"), temporary,
    path.join(repo, "tests/skill-classification/live-bootstrap/bootstrap.mts")], {cwd: repo, encoding: "utf8", timeout: budgetMode ? 90000 : 180000,
    env: {...process.env, TEMP: childTemp, TMP: childTemp, TMPDIR: childTemp}});
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, "R04_EXACT_BOUNDARY_CURRENT_HELPER_FAILED");
} finally {
  if (!parentOwnsRoot) removeSourceScratch(temporary);
}
