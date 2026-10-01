import { describe, expect, it } from "vitest";
import { fidelityReport, section, upperBound } from "../src/fidelity.ts";

describe("fidelity report", () => {
  it("computes the one-sided exact upper bound", () => {
    expect(upperBound(0, 300)).toBeCloseTo(1 - 0.05 ** (1 / 300), 6);
    expect(upperBound(1, 300)).toBeCloseTo(0.0157, 4);
    expect(upperBound(5, 300)).toBeCloseTo(0.0347, 4);
    expect(upperBound(1, 473)).toBeLessThan(0.01);
    expect(upperBound(1, 472)).toBeGreaterThan(0.01);
    expect(upperBound(0, 473, 0.01)).toBeCloseTo(1 - 0.01 ** (1 / 473), 6);
    expect(upperBound(0, 0)).toBe(1);
  });

  it("reads declared sections from GAPS.md", () => {
    const gaps = "# Gaps\n\n## Scope\n\nSlice 1 only.\n\n## Measured divergences\n\nNone.\n";
    expect(section(gaps, "Scope")).toBe("Slice 1 only.");
    expect(section(gaps, "Missing")).toBeNull();
  });

  it("has the nine sections and keeps holdout to totals", () => {
    const md = fidelityReport({
      target: "t",
      at: "now",
      dev: { pass: 10, total: 10 },
      batch: { pass: 473, total: 473 },
      hashHoldout: { pass: 3, total: 4 },
      pixelsReported: 2,
      statuses: [],
      holdoutRules: new Set(),
      determinism: { identical: 10, total: 10 },
      integrity: {
        lockIntact: true,
        lockHash: "abc",
        commit: "c1",
        dirty: false,
        sandbox: false,
        holdoutLooks: 1,
      },
      gaps: null,
      breakerLogs: [],
    });
    const headings = md.split("\n").filter((l) => /^## \d\. /.test(l));
    expect(headings).toHaveLength(9);
    expect(md).toContain("| Pre-registered holdout batch | 473 of 473 | 0 | 0.63 % | 0.97 % |");
    expect(md).toContain("| Hash-split holdout | 3 of 4 | 1 |");
    expect(md).not.toMatch(/hold-\d/);
  });
});
