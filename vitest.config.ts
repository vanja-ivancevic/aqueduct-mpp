import { defineConfig } from "vitest/config";

// Scope tests to our own code. `vendor/` is a read-only upstream clone with its own suite and
// browser-only dependencies — never run it.
export default defineConfig({
  test: {
    include: ["{core,adapters,onboard,runtime,evals,cli}/**/*.test.ts"],
    exclude: ["vendor/**", "node_modules/**"],
  },
});
