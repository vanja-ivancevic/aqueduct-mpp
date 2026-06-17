import { describe, expect, it } from "vitest";
import { unitsCost } from "./pricing";

describe("unitsCost", () => {
  it("multiplies sub-cent prices exactly (no float drift)", () => {
    expect(unitsCost("0.0001", 50)).toBe("0.005");
    expect(unitsCost("0.0001", 10000)).toBe("1");
    expect(unitsCost("0.0001", 3)).toBe("0.0003");
  });

  it("handles zero rows → free", () => {
    expect(unitsCost("0.0001", 0)).toBe("0");
  });

  it("trims trailing zeros and handles whole prices", () => {
    expect(unitsCost("0.10", 3)).toBe("0.3");
    expect(unitsCost("1", 5)).toBe("5");
    expect(unitsCost("2.5", 2)).toBe("5");
  });

  it("rejects a non-integer or negative count", () => {
    expect(() => unitsCost("0.0001", 1.5)).toThrow();
    expect(() => unitsCost("0.0001", -1)).toThrow();
  });
});
