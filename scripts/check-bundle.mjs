import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ROOT } from "./lib.mjs";
import { buildRuntimeBundles, RUNTIME_ARTIFACTS } from "./runtime-bundles.mjs";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "agent-governance-bundle-"));

try {
  await buildRuntimeBundles(temporaryDirectory);
  for (const output of RUNTIME_ARTIFACTS) {
    const [expected, actual] = await Promise.all([
      readFile(path.join(temporaryDirectory, output)),
      readFile(path.join(ROOT, output)),
    ]);
    if (!expected.equals(actual)) {
      throw new Error(`${output} is stale. Run pnpm build and commit the result.`);
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
