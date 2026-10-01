# Measurements: stripe-billing

One entry per pre-registered holdout batch, written after its single look. A batch listed here is
spent: it may be analysed, but no later claim rests on it.

## Batch 1: `hold-001` to `hold-473`

- **Plan:** `analysis-plan.md`, committed in `f932048` before any `hold-` fixture existed.
- **Clone:** rebuilt from scratch by the builder agent in the agent container (one run, 1 h,
  `timings.jsonl`), frozen at `7238f46`.
- **Look:** `npm run verify stripe-billing -- --split holdout`, 2026-10-01 09:50 UTC, the only run
  of this batch (`verify/runs.jsonl`). The line reads `dirty: true` because the dirty-tree check
  did not exclude verify's own outputs (a pathspec bug, fixed later); the scored code is `7238f46`.
- **Result:** 448 of 473 pass, 25 failures (5.3 %). One-sided exact upper bound on the failure
  rate: 7.30 % at 95 %, 8.18 % at 99 %.
- **Decision (per the plan):** k ≥ 2, so the claim "below 1 %" is **not supported**. What the batch
  supports: below 7.3 % at 95 % on `WIDE_DISTRIBUTION`.
- **Where:** every failure involves discounts (amount-off, two coupons, `once` coupons) on
  previews, most with several items; the builder had about 110 dev cases of this distribution.
- **Diff policy** changed between plan and look: a mask for the test card's expiry text (screens
  only, no effect on this logic batch), listed in the fidelity report.

## Batch 2: `hold-b2-001` to `hold-b2-473`

- **Plan:** `analysis-plan-b2.md`, committed in `ad71862` before any `hold-b2-` fixture existed.
- **Clone:** the batch 1 clone after one builder pass in the agent container (32 min,
  `timings.jsonl`) that used the spent batch 1's analysis and 379 new dev probes, and never saw
  batch 2; frozen at `6e78b92` (696 of 696 dev).
- **Look:** `npm run verify stripe-billing -- --split holdout`, 2026-10-01 15:18 UTC, the only run
  of this batch. `dirty: true` has the same cause as above; `git diff 6e78b92` on the harness,
  the target's code, fixtures and policy is empty.
- **Result:** 473 of 473 pass, no failure. One-sided exact upper bound on the failure rate:
  0.63 % at 95 %, 0.97 % at 99 %.
- **Decision (per the plan):** k = 0, so **"below 1 % at 99 % confidence"** on
  `WIDE_DISTRIBUTION`, for the preview of a mid-cycle change in Stripe test mode, and for nothing
  outside that distribution.
- **Diff policy** changed between plan and look: none.
- The same run rescored the spent batch 1 at 473 of 473 and the hash-split holdout at 176 of
  176; neither carries a claim.
