# Measurements: stripe-billing

One entry per pre-registered holdout batch, written after its single look. A batch listed here is
spent: it may be analysed, but no later claim rests on it.

## Batch 1: `hold-001` to `hold-473`

- **Plan:** `analysis-plan.md`, committed in `f932048` before any `hold-` fixture existed.
- **Clone:** rebuilt from scratch by the builder agent in the agent container (one run, 1 h,
  `timings.jsonl`), frozen at `7238f46`.
- **Look:** `npm run verify stripe-billing -- --split holdout`, 2026-10-01 09:50 UTC, the only run
  of this batch (`verify/runs.jsonl`). The line reads `dirty: true` only because `timings.jsonl`,
  an output file, was not yet excluded from the dirty-tree check; the scored code is `7238f46`.
- **Result:** 448 of 473 pass, 25 failures (5.3 %). One-sided exact upper bound on the failure
  rate: 7.30 % at 95 %, 8.18 % at 99 %.
- **Decision (per the plan):** k ≥ 2, so the claim "below 1 %" is **not supported**. What the batch
  supports: below 7.3 % at 95 % on `WIDE_DISTRIBUTION`.
- **Where:** every failure involves discounts (amount-off, two coupons, `once` coupons) on
  previews, most with several items; the builder had about 110 dev cases of this distribution.
- **Diff policy** changed between plan and look: a mask for the test card's expiry text (screens
  only, no effect on this logic batch), listed in the fidelity report.
