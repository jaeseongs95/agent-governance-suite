import { tmpdir } from "node:os";
import path from "node:path";

import { configDefaults, defineConfig } from "vitest/config";

import { ciScope, serverOnlyTests, serverScope } from "./scripts/test-scope.mjs";

// Windows CI runners regularly need more than Vitest's 5s default for the
// SQLite-backed suites, so raise the defaults instead of bumping one test at a
// time. Individual tests may still declare a longer timeout of their own.
// AGS_TEST_SCOPE=ci leaves out the tests the Linux and Windows test servers
// measure, and AGS_TEST_SCOPE=server runs only those (see scripts/test-scope.mjs
// and docs/contributing/testing-and-ci.md).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // In-process tests that store a root create the AGS host ID (shared state); keep it out of the tester's home.
    env: { AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(tmpdir(), "ags-vitest-shared-state") },
    ...(serverScope ? { include: serverOnlyTests().filter(file => !file.endsWith(".node-test.mjs")) } : {}),
    exclude: ciScope ? [...configDefaults.exclude, ...serverOnlyTests()] : configDefaults.exclude
  }
});
