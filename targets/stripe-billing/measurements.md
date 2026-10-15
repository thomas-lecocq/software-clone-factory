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
- **Where:** five of the six root causes involve discounts (amount-off, two coupons, `once`
  coupons), most with several items; one is an interval change at the period end; the builder had about 110 dev cases of this distribution.
- **Diff policy** changed between plan and look: a mask for the test card's expiry text (screens
  only, no effect on this logic batch), listed in the fidelity report.

## Batch 2: `hold-b2-001` to `hold-b2-473`

- **Plan:** `analysis-plan-b2.md`, committed in `ad71862` before any `hold-b2-` fixture existed.
- **Clone:** the batch 1 clone after one builder pass in the agent container (32 min,
  `timings.jsonl`) that used the spent batch 1's analysis and 379 new dev probes, and never saw
  batch 2; frozen at `6e78b92` (696 of 696 dev), tagged `claim-batch-2`.
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

## Batch 3: `hold-b3-001` to `hold-b3-473`

- **Plan:** `analysis-plan-b3.md`, committed in `8d0e7f5` before any `hold-b3-` fixture existed.
- **Distribution:** `WIDE_DISTRIBUTION_V2`, widened where breaker round 1 found failures and drawing
  fewer easy cases (52 Stripe errors in 473, against 74 in batch 2).
- **Clone:** clone A after a third builder pass in the agent container (30 min, $4.50,
  `timings.jsonl`) on the breaker, `wide3-`, `dev-v2-` and minimum-charge fixtures; it never saw
  batch 3. Frozen at `f0799d0` (976 of 976 dev).
- **Look:** `npm run verify stripe-billing -- --split holdout`, 2026-10-13 09:25 UTC, the only run
  of this batch, clean tree.
- **Result:** 466 of 473 pass, 7 failures. One-sided exact upper bound on the failure rate:
  2.76 % at 95 %, 3.35 % at 99 %.
- **Decision (per the plan):** k ≥ 2, so the claim "below 1 %" on `WIDE_DISTRIBUTION_V2` is **not
  supported**. What the batch supports: below 2.8 % at 95 %.
- **Where:** all seven failures are in classic billing mode, most with several items and
  amount-off coupons. The batch is spent; the analyst runs on it next.
- **The claim on batch 2's distribution stands** (`claim-batch-2`); this batch measures a wider
  one, where the same clone, improved, does worse.

## Batch 4: `hold-b4-s1-001` to `hold-b4-s3-157`, staged

- **Plan:** `analysis-plan-b4.md`, committed in `cf677a4` before any `hold-b4-` fixture existed:
  473 cases in three stages, scored sequentially, at most one failure tolerated.
- **Distribution:** `WIDE_DISTRIBUTION_V2`, the one batch 3 rejected the claim on.
- **Clone:** after a fourth builder pass in the agent container, behind the egress allowlist (40
  min, $4.86), on the agent-trace, batch 3 analysis and mutation-hole probes; it never saw batch 4. Frozen at `58e4006` (1013 of 1013 dev).
- **Look:** `npm run verify stripe-billing -- --sequential hold-b4 --max-failures 1`,
  2026-10-13 14:47 UTC, the only run of this batch, clean tree. Every stage was scored.
- **Result:** 472 of 473 pass, one failure (`hold-b4-s1-089`). One-sided exact upper bound: 0.999 %
  at 95 %, 1.40 % at 99 %.
- **Decision (per the plan):** all stages scored and k = 1, so **"below 1 % at 95 % confidence"**
  on `WIDE_DISTRIBUTION_V2`, not at 99 %.
- **Later looks (no claim):** three runs of `verify --split all` on 2026-10-14, same clone, to
  regenerate the reports and the reliability card; the same single failure.

## Batch 5: `hold-b5-s1-001` to `hold-b5-s3-157`, staged

- **Plan:** `analysis-plan-b5.md`, committed in `42baf92` before any `hold-b5-` fixture existed:
  473 cases in three stages, scored sequentially, at most one failure tolerated.
- **Distribution:** `WIDE_DISTRIBUTION_V2`, as batches 3 and 4.
- **Clone:** after a fifth builder pass in the agent container (35 min, $5.44; a first attempt was
  cut off at two hours with nothing copied back), on the v4 dev probes (expanded discount
  coupons, invoice items across customers, draft invoices, cancel_at at the period end, the
  interval-change boundary); it never saw batch 5. Frozen at `539349b` (1029 of 1029 dev). Batch 4's
  single failure was not analysed: two analyst runs were stopped at two hours without a report.
- **Look:** `npm run verify stripe-billing -- --sequential hold-b5 --max-failures 1`,
  2026-10-14, the only run of this batch, clean tree. Every stage was scored.
- **Result:** 472 of 473 pass, one failure (`hold-b5-s1-068`, a multi-item change with
  discounts, like batch 4's). One-sided exact upper bound: 0.999 % at 95 %, 1.40 % at 99 %.
- **Decision (per the plan):** all stages scored and k = 1, so **"below 1 % at 95 % confidence"**
  on `WIDE_DISTRIBUTION_V2` for clone v4, not at 99 %. The 99 % claim on this distribution is
  still unsupported.
- **Later looks (no claim):** two runs of `verify --split all` on 2026-10-14, same clone, to
  regenerate the reports and the reliability card; the same single failure.

## Batch 6: `hold-b6-s1-001` to `hold-b6-s3-157`, staged

- **Plan:** `analysis-plan-b6.md`, committed in `6bdbf3a` before any `hold-b6-` fixture existed:
  473 cases in three stages, scored sequentially, at most one failure tolerated.
- **Distribution:** `WIDE_DISTRIBUTION_V2`, as batches 3 to 5.
- **Clone:** after a sixth builder pass in the agent container (28 min, $4.67), on the v5 dev
  probes: 150 cases of the area batches 4 and 5 failed in (several items, two coupons), the seven
  designs of the batch 4 analysis (`analysis/hold-b4-failures.md`, analyst 8 min, $1.94), and
  probes for v4's mutation holes and its builder's unpinned choices; it never saw batch 6. Frozen
  at `fdbdd0e` (1196 of 1196 dev).
- **Look:** `npm run verify stripe-billing -- --sequential hold-b6 --max-failures 1`,
  2026-10-15, the only run of this batch, clean tree. Every stage was scored.
- **Result:** 473 of 473 pass. One-sided exact upper bound: 0.63 % at 95 %, 0.97 % at 99 %.
- **Decision (per the plan):** all stages scored and k = 0, so **"below 1 % at 99 % confidence"**
  on `WIDE_DISTRIBUTION_V2`, for clone v5.
- **Later looks (no claim):** three runs of `verify --split all` on 2026-10-15, same clone, to
  regenerate the reports and the reliability card; no holdout failure.

## Secondary uses of batch 2 (no claim)

- **Ablation of the second builder pass:** the clone measured on batch 1 (`7238f46`) scored on
  batch 2 in a separate worktree, 2026-10-01: 451 of 473 (22 failures; bound 6.58 % at 95 %).
  It never saw batch 2 either; the result says what the pass driven by batch 1's analysis added.
- **Builder variance:** two more clones built from scratch (`variance.md`), each scored once on
  batch 2 in its own worktree: 472 of 473 each, failing different cases.
- **Looks outside the run log.** These three worktree runs (the ablation and builds B and C) were
  logged in their worktrees, which were not kept, so `verify/runs.jsonl` misses them: batch 2 had
  at least three more looks than the fidelity report counts. Worktree runs are now also logged in
  the main checkout.
