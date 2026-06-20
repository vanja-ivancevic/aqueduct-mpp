import { describe, expect, it } from "vitest";
import { localCompute } from "./local";
import { DEFAULT_SPEC, type DeploySpec } from "./provider";

const spec: DeploySpec = { ...DEFAULT_SPEC, image: "ghcr.io/acme/aqueduct:1.2.3", port: 9000 };

describe("localCompute.render", () => {
  it("emits a compose file with the image and env interpolation (no baked secrets)", () => {
    const l = localCompute.render(spec);
    expect(l.filename).toBe("docker-compose.yml");
    expect(l.content).toContain("image: ghcr.io/acme/aqueduct:1.2.3");
    expect(l.content).toContain('"9000:9000"');
    expect(l.content).toContain("${AQUEDUCT_PRIVATE_KEY:?set AQUEDUCT_PRIVATE_KEY}");
    expect(l.content).not.toContain("CHANGE_ME");
  });

  it("is a pure, deterministic renderer", () => {
    expect(localCompute.render(spec).content).toBe(localCompute.render(spec).content);
  });
});
