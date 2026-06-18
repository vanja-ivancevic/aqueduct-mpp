import { describe, expect, it } from "vitest";
import { akashCompute } from "./akash";
import { localCompute } from "./local";
import { DEFAULT_SPEC, type DeploySpec } from "./provider";

const spec: DeploySpec = { ...DEFAULT_SPEC, image: "ghcr.io/acme/aqueduct:1.2.3", port: 9000 };

describe("akashCompute.render", () => {
  it("emits SDL with the image, exposed port, and SSE-ready ingress timeouts", () => {
    const a = akashCompute.render(spec);
    expect(a.filename).toBe("akash.deploy.yaml");
    expect(a.content).toContain("image: ghcr.io/acme/aqueduct:1.2.3");
    expect(a.content).toContain("port: 9000");
    expect(a.content).toContain("global: true");
    // streaming-readiness: ingress must not cut long-lived connections at the 60s default
    expect(a.content).toContain("read_timeout: 3600000");
    expect(a.content).toContain('next_cases: ["off"]');
    // secrets are placeholders, never baked
    expect(a.content).toContain("AQUEDUCT_PRIVATE_KEY=CHANGE_ME");
  });

  it("is a pure, deterministic renderer", () => {
    expect(akashCompute.render(spec).content).toBe(akashCompute.render(spec).content);
  });
});

describe("localCompute.render", () => {
  it("emits a compose file with the same image and env interpolation (no baked secrets)", () => {
    const l = localCompute.render(spec);
    expect(l.filename).toBe("docker-compose.yml");
    expect(l.content).toContain("image: ghcr.io/acme/aqueduct:1.2.3");
    expect(l.content).toContain('"9000:9000"');
    expect(l.content).toContain("${AQUEDUCT_PRIVATE_KEY:?set AQUEDUCT_PRIVATE_KEY}");
    expect(l.content).not.toContain("CHANGE_ME");
  });
});
