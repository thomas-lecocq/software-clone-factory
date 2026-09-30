# Gaps: stripe-billing

Owner: main session. The hand-written account of where the clone is wrong, might be wrong, or was
never compared. The generated list is `GAPS.generated.md`; the scores are in `verify/report.md`.
Final measurement (2026-09-23 18:25Z, `verify/runs.jsonl`): clean holdout `fresh2` 29 of 29
(Wilson 95 % 0.88 to 1.00; exact one-sided 95 % upper bound on the divergence rate 9.8 %, over the
random distribution only), slice 2 holdout 5 of 5, all fixtures 329 of 329.

## Measured divergences

None in the final measurement. Divergences measured earlier and since fixed through new dev
probes (never by reading the holdout):

| Iteration | Holdout case                | Behaviour                                           | Fixed by                                        |
| --------- | --------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| 1         | `d-month-to-year`           | interval change prorated, not reset                 | `t-month-to-year-*` dev probes                  |
| 1         | `d-pct20-sub-pct15-preview` | two coupons on the credit line                      | `t-two-coupons-*`, `b-off300-sub-pct15-preview` |
| 1         | `rand-005`                  | one cent, classic mode, percent coupon              | `t-disc-round-*`                                |
| 2         | `fresh-007`                 | one cent, classic mode, amount-off `once` coupon    | `u-classic-off-*`                               |
| 2         | `t-year-to-month`           | proration date past the new monthly period rejected | `u-year-to-month-*`                             |

Those holdout cases pass now, but they are spent and prove nothing further.

## Rules that fit the fixtures but are thin

- **Amount-off allocation across several lines (DSC-03).** Never observed: every probe has one
  discountable line.
- **Classic percent charge.** One fixture (`fresh2-081`) separates the candidate formulas.

- **Rounding at exactly .5 (PRO-04).** Six `.5` lines in dev. The builder's model (credits away
  from zero, classic charges half up, flexible charges as a floating-point effect) fits all six,
  but is a hypothesis with six data points.
- **Retry schedule after a failed payment (LIF-06).** One data point (3 attempts after 5 days).
- **Classic vs flexible (MOD-01).** One-cent differences under percent coupons; the documented
  difference in totals was never reproduced.
- **UI (UI-01 to UI-10).** 8 walkthroughs; 5 of the 15 slice 2 fixtures and none of the slice 1
  walkthroughs are in the holdout.

## Compared nowhere (outside the probe space)

Not covered by a fixture; behaviour inferred from the documentation at most; unverified:
taxes, currencies other than USD, several items per subscription, metered and tiered prices,
subscription schedules, prorated trials, coupons with `repeating` duration, promotion codes,
customer balance applied to later invoices, 3D Secure and other payment failures than
`pm_card_chargeCustomerFail`, portal flows other than plan change and cancel/renew, the portal's
retention coupon (its endpoint is called but never returns an offer in our configuration),
the cancellation reason dialog (disabled in every walkthrough).

## Blind spots by design

- **Lifecycle snapshots are a projection** (`lifecycle.ts`): status, cancellation dates, period,
  latest invoice amounts and lines, invoice count. Other subscription and invoice fields are not
  compared in slice 2. Slice 1 previews are compared field by field, all 74 top-level fields.
- **UI snapshots drop link targets** (`- /url:` lines): they carry session secrets and internal
  paths.
- **UI request bodies are not compared**: a walkthrough records the method and path of each portal
  request (`ui.ts`), not its body or response.
- **Card expiry** ("Expires 09/2027") follows the real date on Stripe; it is a constant in the
  clone. The fixtures are frozen, so they will keep passing after Stripe's test card rolls over:
  the divergence becomes invisible, not visible.
- **Test mode only.** Live mode is assumed to compute the same invoices; unverified.
- **Account constants** (country `FR`, name pseudonymised to "AcmeCo") are seed data.

## Evaluator integrity

- **Clean measures:** `fresh2` (29 of 29) and the slice 2 holdout (5 of 5). Spent or informed:
  the v1 holdout, `fresh-*` (quoted after iteration 2), and the `t-*`, `b-*` and `u-*` probes.
- **Builder pass 3 ran in the sandbox** (`harness/run-builder.sh`): no holdout files, no audit, no
  git history; only `clone/` copied back. File-level isolation only: `node_modules` was a symlink
  back into the repository and the sandbox held `.env` during that run (both fixed after audit 3),
  and nothing stops a same-user process from reading the repository by absolute path. Passes 1 and 2 ran in the repository under the weaker,
  hook-only isolation that audit 2 bypassed; the final clean measure does not rest on them, but the
  clone they wrote is the base pass 3 extended.
- **Verify runs are logged** from 2026-09-23 17:33Z (`verify/runs.jsonl`); `fresh2` holdout was
  scored once, in the final run. Earlier "measured once" statements rest on the journal.
- **Regressions:** nine during builder pass 2, reviewed with root causes in `failures.jsonl`.
- **Rule edits after measurement:** INT-01 and four provenances changed in `rules.json` after
  iteration 2's run; statements do not change scores, but the report's provenance column did.
