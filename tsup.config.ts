import { defineConfig } from "tsup";

// Three outputs: the `aqueduct` CLI and `aqueduct-mcp` MCP server (shebangs preserved from their
// entry files) and the library barrel.
// Runtime deps (duckdb native, mppx, viem, hono) stay external — installed via npm, never bundled.
export default defineConfig({
  entry: { cli: "cli/index.ts", mcp: "mcp/server.ts", index: "index.ts" },
  format: "esm",
  target: "node20",
  platform: "node",
  dts: true,
  clean: true,
  sourcemap: true,
});
