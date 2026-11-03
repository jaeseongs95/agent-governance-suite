import { configDefaults, defineConfig } from "vitest/config";

import { ciScope, serverOnlyTests } from "./scripts/test-scope.mjs";

// Windows CI runners regularly need more than Vitest's 5s default for the
// SQLite-backed suites, so raise the defaults instead of bumping one test at a
// time. Individual tests may still declare a longer timeout of their own.
// AGS_TEST_SCOPE=ci leaves out the tests the Linux and Windows test servers
// measure (see scripts/test-scope.mjs and docs/ci-and-test-servers.md).
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    exclude: ciScope ? [...configDefaults.exclude, ...serverOnlyTests()] : configDefaults.exclude
  }
});
