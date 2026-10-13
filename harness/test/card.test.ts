import { describe, expect, it } from "vitest";
import { level, reliabilityCard, type CardInput } from "../src/card.ts";

const base: CardInput = {
  target: "t",
  at: "now",
  batches: { hold: { pass: 448, total: 473 }, "hold-b2": { pass: 473, total: 473 } },
  plans: {
    hold: { file: "analysis-plan.md", policyChanges: [], preRegistered: "yes" },
    "hold-b2": { file: "analysis-plan-b2.md", policyChanges: [], preRegistered: "yes" },
  },
  looks: { hold: 3, "hold-b2": 1 },
  dev: { pass: 733, total: 748 },
  adversarial: { pass: 28, total: 40 },
  determinism: { identical: 10, total: 10 },
  lockHash: "abc",
  commit: "c1",
  dirty: false,
  mutation: { killed: 30, valid: 40, at: "2026-10-13T00:00:00Z" },
  auditors: { found: 12, planted: 12 },
};

describe("reliability card", () => {
  it("rates from the bound: A at 99 %, B at 95 %, C otherwise", () => {
    expect(level({ pass: 473, total: 473 }).name).toBe("A");
    expect(level({ pass: 472, total: 473 }).name).toBe("B");
    expect(level({ pass: 448, total: 473 }).name).toBe("C");
    expect(level({ pass: 299, total: 299 }).name).toBe("B");
  });

  it("speaks about the latest pre-registered batch, with its looks", () => {
    const md = reliabilityCard(base);
    expect(md).toContain("**A**: below 1 % of cases diverge, at 99 % confidence");
    expect(md).toContain(
      "batch `hold-b2-`, 473 of 473; plan `analysis-plan-b2.md`, committed first",
    );
    expect(md).toContain("first and only look");
    expect(md).toContain("30 of 40 planted bugs caught by the fixtures (run 2026-10-13)");
    expect(md).toContain("28 of 40 pass; they are dev cases the builder may have learnt");
    expect(md).toContain("https://img.shields.io/badge/reliability-level%20A-2ea44f");
    expect(md).toContain("https://img.shields.io/badge/breaker%20probes-28%2F40-blue");
  });

  it("refuses a level when the plan came after the batch, or when there is no plan", () => {
    const late = reliabilityCard({
      ...base,
      plans: {
        ...base.plans,
        "hold-b2": { file: "analysis-plan-b2.md", policyChanges: [], preRegistered: "no" },
      },
    });
    expect(late).toContain("unrated");
    expect(reliabilityCard({ ...base, plans: {} })).toContain("unrated: no pre-registered batch");
  });
});
