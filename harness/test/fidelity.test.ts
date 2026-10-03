import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchOf, fidelityReport, looksPerSet, section, upperBound } from "../src/fidelity.ts";

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

  it("groups batch IDs by prefix", () => {
    expect(batchOf("hold-042")).toBe("hold");
    expect(batchOf("hold-b2-042")).toBe("hold-b2");
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
      batches: {
        hold: { pass: 448, total: 473 },
        "hold-b2": { pass: 473, total: 473 },
        "hold-b3": { pass: 10, total: 10 },
      },
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
      },
      looks: { hash: 3, hold: 2, "hold-b2": 1 },
      plans: {
        hold: {
          file: "analysis-plan.md",
          policyChanges: ["abc123 Mask recording-date text"],
          preRegistered: "yes",
        },
        "hold-b2": { file: "analysis-plan-b2.md", policyChanges: [], preRegistered: "yes" },
        "hold-b3": { file: "analysis-plan-b3.md", policyChanges: null, preRegistered: "no" },
      },
      gaps: null,
      breakerRounds: ["breaker-round1.json"],
    });
    const headings = md.split("\n").filter((l) => /^## \d\. /.test(l));
    expect(headings).toHaveLength(9);
    expect(md).toContain(
      "| Pre-registered batch `hold-b2-` | 473 of 473 | 0 | 0.63 % | 0.97 % | first and only look",
    );
    expect(md).toContain(
      "| Pre-registered batch `hold-` | 448 of 473 | 25 | 7.30 % | 8.18 % | spent: 2 looks",
    );
    expect(md).toMatch(/\| Hash-split holdout \| 3 of 4 \| 1 \|.*looked at 3 time\(s\).*no claim/);
    expect(md).not.toMatch(/hold-\d/);
    expect(md).toMatch(/batch `hold-b3-` \| 10 of 10 .*committed after the batch: no claim/);
    expect(md).toContain(
      "Batch `hold-`: diff policy changed since `analysis-plan.md` was committed: abc123",
    );
    expect(md).toContain("Batch `hold-b2-`: diff policy unchanged");
    expect(md).toContain("Batch `hold-b3-`: whether the diff policy changed");
    expect(md).toContain("1 breaker round(s) stored (breaker-round1.json)");
  });

  it("counts looks per set across locks, legacy runs counting for every set", () => {
    const dir = mkdtempSync(join(tmpdir(), "scf-looks-"));
    const file = join(dir, "runs.jsonl");
    const lines = [
      { lock: "a", holdout: { total: 5 } },
      { lock: "b", holdout: { total: 5 }, sets: ["hash", "hold"] },
      { lock: "c", holdout: { total: 0 }, sets: [] },
      { lock: "d", holdout: { total: 9 }, sets: ["hash", "hold", "hold-b2"] },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(looksPerSet(file, ["hash", "hold", "hold-b2"])).toEqual({
      hash: 3,
      hold: 3,
      "hold-b2": 2,
    });
    rmSync(dir, { recursive: true, force: true });
  });
});
