#!/usr/bin/env node
/**
 * Aqueduct MCP server — the same three Tap ops the agent skill exposes (`skills/aqueduct/`), over
 * MCP/stdio instead of a CLI. An MCP-capable agent (Claude Code, Claude Desktop, …) can DISCOVER Taps,
 * read a Tap's terms for FREE, and BUY exactly the rows it needs.
 *
 * This is a thin transport over the shared consumption client (`adapters/client`) — all logic lives
 * there, so the skill and this server can never drift. It sits OUTSIDE `core/` and imports no vendor
 * SDK into core (core boundaries): it composes the existing client, which already runs the MPP
 * session agent-side. The wallet stays agent-side too — `buyRows` pays with the key from the
 * environment, non-custodial (invariant 5). No LLM, no upstream fetch beyond the client's own.
 *
 * Run:  npx aqueduct-mcp   (or  tsx mcp/server.ts )
 * Env:  AQUEDUCT_AGENT_KEY  — 0x funded Tempo wallet, required only for aqueduct_query (spends money)
 *       AQUEDUCT_RPC_URL    — Tempo JSON-RPC, defaults to DEFAULT_RPC_URL
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buyRows, discover, fetchSchema } from "../adapters/client/client";

// ── tool input shapes — mirror the constrained query interface in core/config.ts ─────────────
// (We accept the request loosely and let the Tap validate it server-side against ITS declared
// interface; a bad field/op is a free 400, never a charge. So we keep these schemas permissive and
// describe the real contract in the tool descriptions and via aqueduct_schema.)
const FilterOp = z.enum(["eq", "ne", "lt", "lte", "gt", "gte", "in", "like"]);

const filterShape = {
  field: z.string().describe("a filterable column, as listed by aqueduct_schema"),
  op: FilterOp.describe("comparison operator allowed on this field by the schema"),
  value: z.unknown().describe("the value to compare against (an array for the 'in' operator)"),
};

const sortShape = {
  field: z.string().describe("a sortable column, as listed by aqueduct_schema"),
  dir: z.enum(["asc", "desc"]).default("asc").describe("sort direction"),
};

const queryInputShape = {
  tapUrl: z.string().describe("the Tap's base URL (from aqueduct_discover or given directly)"),
  select: z
    .array(z.string())
    .optional()
    .describe("columns to return; omit for all declared columns. Only return what you need."),
  filters: z
    .array(z.object(filterShape))
    .optional()
    .describe("narrowing conditions — only declared field+op pairs (see aqueduct_schema)"),
  sort: z.array(z.object(sortShape)).optional().describe("ordering, by sortable columns only"),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("max rows to return — YOU PAY PER ROW, so keep this tight"),
  offset: z.number().int().min(0).optional().describe("rows to skip (pagination)"),
};

// MCP tool results are content blocks; we hand back JSON as text so the agent can parse it.
function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

const server = new McpServer({ name: "aqueduct", version: "0.1.0" });

server.registerTool(
  "aqueduct_discover",
  {
    title: "Discover Aqueduct Taps",
    description:
      "Find Aqueduct Taps — metered, agent-payable data feeds — in MPP's public registry. " +
      "FREE, no wallet, signs nothing. CALL THIS FIRST when you need data from a large external " +
      "dataset and don't already have a Tap URL. Returns [{ id, name, url, description, price, " +
      "currency }]. Pick a `url`, then call aqueduct_schema on it before buying.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("free-text to narrow Taps by name/description, e.g. 'japanese cities'"),
      registryUrl: z.string().optional().describe("override the MPP registry URL (rarely needed)"),
    },
  },
  async ({ query, registryUrl }) => {
    try {
      const taps = await discover(query, registryUrl ? { registryUrl } : {});
      return jsonResult(taps);
    } catch (e) {
      return errorResult(`discover failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "aqueduct_schema",
  {
    title: "Read a Tap's terms (free)",
    description:
      "Read a Tap's schema, constrained query interface, and per-row price. FREE, no wallet, signs " +
      "nothing. ALWAYS call this before aqueduct_query — it tells you which columns are filterable " +
      "(and with which operators: eq ne lt lte gt gte in like), which are selectable/sortable, the " +
      "row limits, and the price. Never guess columns or operators: an undeclared one is rejected " +
      "(no charge), so read the terms first.",
    inputSchema: {
      tapUrl: z.string().describe("the Tap's base URL (from aqueduct_discover or given directly)"),
    },
  },
  async ({ tapUrl }) => {
    try {
      return jsonResult(await fetchSchema(tapUrl));
    } catch (e) {
      return errorResult(`schema failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "aqueduct_query",
  {
    title: "Buy rows from a Tap (SPENDS MONEY)",
    description:
      "Buy exactly the rows your query selects. THIS SPENDS MONEY: it opens an MPP session and pays " +
      "`returned rows × unitPrice` on Tempo, settled on close. Requires AQUEDUCT_AGENT_KEY (a funded " +
      "wallet) in the environment. Build the request ONLY from fields/operators that aqueduct_schema " +
      "declared — an undeclared field/op is a free 400, not a guess that works. A query matching 0 " +
      "rows is free. Keep `limit` tight; refine with a cheap exploratory query (limit 1) before a " +
      "larger pull. Returns { count, amount, cached, settlement, rows }.",
    inputSchema: queryInputShape,
  },
  async ({ tapUrl, select, filters, sort, limit, offset }) => {
    const key = process.env.AQUEDUCT_AGENT_KEY;
    if (!key?.startsWith("0x")) {
      return errorResult(
        "aqueduct_query needs a funded wallet: set the AQUEDUCT_AGENT_KEY environment variable to a " +
          "0x-prefixed Tempo private key before running the MCP server. (aqueduct_discover and " +
          "aqueduct_schema are free and need no key.)",
      );
    }
    // Only forward the fields the caller actually set — the Tap fills its own defaults (limit, etc.).
    const request: Record<string, unknown> = {};
    if (select !== undefined) request.select = select;
    if (filters !== undefined) request.filters = filters;
    if (sort !== undefined) request.sort = sort;
    if (limit !== undefined) request.limit = limit;
    if (offset !== undefined) request.offset = offset;

    try {
      const result = await buyRows(tapUrl, request, {
        key,
        rpcUrl: process.env.AQUEDUCT_RPC_URL,
        maxDeposit: process.env.AQUEDUCT_MAX_DEPOSIT,
      });
      return jsonResult({
        count: result.count,
        amount: `${result.amount} pathUSD`,
        cached: result.cached,
        settlement: result.settlement,
        rows: result.rows,
      });
    } catch (e) {
      return errorResult(`query failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio is the transport; never write logs to stdout (it corrupts the JSON-RPC stream) — use stderr.
  process.stderr.write("aqueduct MCP server ready on stdio\n");
}

main().catch((e) => {
  process.stderr.write(`aqueduct-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
