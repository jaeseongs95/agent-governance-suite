import { defineConfig } from "vitest/config";

// Windows CI runners regularly need more than Vitest's 5s default for the
// SQLite-backed suites, so raise the defaults instead of bumping one test at a
// time. Individual tests may still declare a longer timeout of their own.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
});
