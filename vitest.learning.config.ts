import { defineConfig } from "vitest/config";

/**
 * Test configuration for the learning module and the acceptance suites.
 *
 * Separate from `vitest.config.ts` on purpose: the upstream suite must stay
 * untouched and green, while these tests need a process-per-file pool (several
 * suites open SQLite databases and bind ports) and a longer timeout for the
 * Git- and HTTP-heavy flows.
 */
export default defineConfig({
  test: {
    include: ["test/learning/**/*.test.ts"],
    // Fail closed: every learning test runs behind the offline guard and with a
    // per-test temporary CODETRAIL_DATA_DIR (architecture §17.5, issue-07).
    setupFiles: ["test/learning/setup/guard.ts"],
    pool: "forks",
    testTimeout: 30000,
    sequence: {
      concurrent: false,
    },
  },
});
