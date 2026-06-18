import { describe, expect, it } from "vitest";
import { parseConfig } from "./config";
import { AQUEDUCT_TAG, type MppService, renderServiceEntry, selectTaps } from "./registry";

function config() {
  const r = parseConfig({
    version: 1,
    name: "exoplanets",
    source: {
      format: "csv",
      location: { via: "path", ref: "examples/exoplanets.csv" },
      authEnv: null,
      contract: { determinism: "deterministic", freshnessWindow: "24h" },
    },
    schema: [{ name: "name", type: "string", required: true }],
    query: {
      filters: [{ field: "name", ops: ["eq"] }],
      selectable: "*",
      sortable: ["name"],
      maxLimit: 1000,
      defaultLimit: 100,
    },
    pricing: {
      unit: "row",
      unitDefinition: "one row of exoplanets",
      unitPrice: "0.0001",
      currency: "0x20c0000000000000000000000000000000000000",
    },
    cache: { key: "queryHash", ttl: "1h" },
    evals: { golden: [], invariants: [], sampleSize: 5 },
    mpp: {
      intent: "session",
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      currency: "0x20c0000000000000000000000000000000000000",
      feePayer: true,
    },
  });
  if (!r.ok) throw new Error("fixture config invalid");
  return r.value;
}

describe("renderServiceEntry", () => {
  it("derives an MPP registry entry from the config + deploy URL, tagged aqueduct", () => {
    const e = renderServiceEntry(config(), { url: "https://exo.example.com/" });
    expect(e.id).toBe("exoplanets");
    expect(e.url).toBe("https://exo.example.com"); // trailing slash trimmed
    expect(e.categories).toEqual(["data"]);
    expect(e.integration).toBe("third-party");
    expect(e.tags).toContain(AQUEDUCT_TAG);
    expect(e.methods.tempo?.intents).toEqual(["session"]);

    const schema = e.endpoints.find((x) => x.path === "/schema");
    const query = e.endpoints.find((x) => x.path === "/query");
    expect(schema?.payment).toBeNull(); // discovery is free
    expect(query?.payment?.intent).toBe("session");
    expect(query?.payment?.recipient).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(query?.payment?.unitType).toBe("row");
    expect(query?.payment?.dynamic).toBe(true); // amount = rows × price, not fixed
    expect(query?.payment?.amountHint).toBe("0.0001/row");
  });

  it("is pure — same inputs render the same entry", () => {
    const a = renderServiceEntry(config(), { url: "https://x" });
    const b = renderServiceEntry(config(), { url: "https://x" });
    expect(a).toEqual(b);
  });
});

describe("selectTaps", () => {
  const ours = renderServiceEntry(config(), { url: "https://exo.example.com" });
  const foreign: MppService = {
    id: "fax",
    name: "Fax",
    url: "https://fax.example.com",
    description: "send a fax",
    methods: { tempo: { intents: ["charge"] } },
    endpoints: [
      { method: "POST", path: "/v1/fax", payment: { intent: "charge", method: "tempo" } },
    ],
  };

  it("keeps only Aqueduct Taps out of a mixed registry list", () => {
    const taps = selectTaps([ours, foreign]);
    expect(taps.map((t) => t.id)).toEqual(["exoplanets"]);
    expect(taps[0]?.price).toBe("0.0001/row");
  });

  it("detects an untagged Tap by its free /schema + paid /query contract", () => {
    const untagged: MppService = { ...ours, tags: [] };
    expect(selectTaps([untagged]).map((t) => t.id)).toEqual(["exoplanets"]);
  });

  it("narrows by a free-text query on name/description", () => {
    expect(selectTaps([ours], "exoplanet")).toHaveLength(1);
    expect(selectTaps([ours], "weather")).toHaveLength(0);
  });
});
