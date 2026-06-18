/**
 * Aqueduct MCP server — exposes the consumption client (`discover` / `schema` / `query`) as MCP tools
 * so any MCP-native host (Claude Desktop, Cursor, …) can find and buy Tap data. It's a thin transport
 * over `client.ts`; all real logic lives there.
 *
 * Run LOCALLY with the user's own wallet (`AQUEDUCT_AGENT_KEY`). It is never a hosted/shared payer — a
 * central one would hold funds and break non-custody (invariant 5). The wallet stays on this side.
 *
 * Transport is MCP stdio: newline-delimited JSON-RPC 2.0 on stdin/stdout. We hand-roll the three
 * methods a tools-only server needs (`initialize`, `tools/list`, `tools/call`) rather than pull a
 * heavy/alpha SDK — it's small, stable in shape, and legible in one read. NOTHING but protocol JSON
 * may go to stdout; all diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { buyRows, discover, fetchSchema } from "./client";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "aqueduct", version: "0.1.0" };

const TOOLS = [
  {
    name: "aqueduct_discover",
    description:
      "Find Aqueduct Taps (metered, agent-payable datasets) in MPP's public registry. Optionally narrow by a free-text query. Free; no payment.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "free-text filter on name/description" },
      },
    },
  },
  {
    name: "aqueduct_schema",
    description:
      "Read a Tap's terms before paying: columns, the constrained query interface (filterable/sortable fields), and the per-row price. Free; no payment.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "the Tap base URL" } },
      required: ["url"],
    },
  },
  {
    name: "aqueduct_query",
    description:
      "Buy exactly the rows a query selects from a Tap. Pays rows × unitPrice over an MPP session (settled on close) using the local AQUEDUCT_AGENT_KEY wallet. Form the request from aqueduct_schema first — undeclared fields/ops are rejected before any charge. A 0-row match is free.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "the Tap base URL" },
        request: {
          type: "object",
          description:
            "constrained query: { select?, filters?: [{field,op,value}], sort?, limit?, offset? }",
        },
      },
      required: ["url", "request"],
    },
  },
];

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;

async function callTool(name: string, args: Json): Promise<unknown> {
  switch (name) {
    case "aqueduct_discover":
      return discover(typeof args.query === "string" ? args.query : undefined);
    case "aqueduct_schema":
      return fetchSchema(String(args.url));
    case "aqueduct_query": {
      const key = process.env.AQUEDUCT_AGENT_KEY;
      if (!key) throw new Error("set AQUEDUCT_AGENT_KEY (a funded Tempo wallet) to buy rows");
      return buyRows(String(args.url), args.request, {
        key,
        rpcUrl: process.env.AQUEDUCT_RPC_URL,
        maxDeposit: process.env.AQUEDUCT_MAX_DEPOSIT,
      });
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

/** Handle one JSON-RPC request, return its result payload (or throw to produce an error response). */
async function handle(method: string, params: Json): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion:
          typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      };
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = String(params.name);
      const args = isObj(params.arguments) ? params.arguments : {};
      try {
        const result = await callTool(name, args);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        // Tool failures are reported in-band (isError), not as protocol errors — the model sees them.
        return {
          content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }],
          isError: true,
        };
      }
    }
    default:
      throw rpcError(-32601, `method not found: ${method}`);
  }
}

interface RpcErr {
  code: number;
  message: string;
}
const rpcError = (code: number, message: string): RpcErr => ({ code, message });

function send(msg: Json): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

/** Run the server until stdin closes. */
export function runMcpServer(): void {
  const rl = createInterface({ input: process.stdin });
  process.stderr.write("aqueduct mcp: ready on stdio\n");

  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) return;
    let msg: Json;
    try {
      msg = JSON.parse(text) as Json;
    } catch {
      return; // not JSON — ignore, can't even form an error reply without an id
    }

    const { id, method, params } = msg as { id?: unknown; method?: string; params?: unknown };
    // Notifications (no id) — e.g. notifications/initialized — get no response.
    if (id === undefined || id === null) return;

    try {
      const result = await handle(String(method), isObj(params) ? params : {});
      send({ jsonrpc: "2.0", id, result } as Json);
    } catch (e) {
      const err = isRpcErr(e) ? e : rpcError(-32603, e instanceof Error ? e.message : String(e));
      send({ jsonrpc: "2.0", id, error: err } as Json);
    }
  });
}

const isRpcErr = (e: unknown): e is RpcErr =>
  isObj(e) && typeof e.code === "number" && typeof e.message === "string";
