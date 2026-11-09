import { defineConfig } from "vitest/config";

/**
 * Three test projects:
 *  - unit:          pure logic, no network, no database
 *  - integration:   live PostgreSQL (DATABASE_URL) + in-process fake provider servers
 *  - authorization: the isolation proofs (RLS + centralized authorize()); live PostgreSQL
 *
 * Integration/authorization tests are skipped with an explicit message when
 * DATABASE_URL is not set. They never silently pass.
 */
export default defineConfig({
  test: {
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**", "apps/*/src/**"],
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/*.authz.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "integration",
          include: ["packages/*/src/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
          globalSetup: ["./test/global-setup.ts"],
        },
      },
      {
        test: {
          name: "authorization",
          include: ["packages/*/src/**/*.authz.test.ts", "apps/*/src/**/*.authz.test.ts"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
          fileParallelism: false,
          globalSetup: ["./test/global-setup.ts"],
        },
      },
    ],
  },
});
