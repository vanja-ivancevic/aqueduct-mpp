import { defineConfig } from "tsup";

// Two outputs: the `aqueduct` CLI (shebang preserved from cli/index.ts) and the library barrel.
// Runtime deps (duckdb native, mppx, viem, hono) stay external — installed via npm, never bundled.
export default defineConfig({
  entry: { cli: "cli/index.ts", index: "index.ts" },
  format: "esm",
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
});
