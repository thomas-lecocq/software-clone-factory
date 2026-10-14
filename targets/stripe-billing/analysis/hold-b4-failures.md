# Holdout batch 4 (hold-b4, stages s1..s3, 473 cases): the 1 failure

Method: the case was replayed on the clone (`startCloneProcess` on a free port, `POST /__reset`
before each case, the adapter's `run` with the fixture's `input`), then diffed with `diff`/`blocking`
under `policy.json`. A replay of all 473 hold-b4 cases fails exactly `hold-b4-s1-089`, the only
entry in `failures.json`, with the same 7 diffs on two runs. Hypotheses were checked by script
against every fixture available: 1029 dev and 473 hold-b4. That covers 148 credit lines in
flexible immediate invoices, 843 flexible credit lines, and all non-immediate flexible credits.

## 1. Failing case

| Case           | First differing fields                                                                           | Expected => actual                                                                 | Category |
| -------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | -------- |
| hold-b4-s1-089 | `preview.lines.data[0].discount_amounts[0..1]`, `.pretax_credit_amounts[0..1]` (the credit line) | `[{di#2, 0}]` => `[{di#1, 0}, {di#2, 0}]`, and likewise in `pretax_credit_amounts` | A        |

The amounts, totals, descriptions, line count and invoice-level lists all match. Only the credit
line's discount list differs: the target lists only the 67 % coupon (di#2). The clone also lists
the $647.29 amount-off (di#1).

Case shape: flexible mode, `always_invoice`, four items. Two forever coupons: $647.29 off, then
67 %. Item 3 ($2.25 × 1) changes to $3.30 × 11 at r/P = 421784/2678400 ≈ 0.157. On the first
invoice item 3 got 1 cent of the amount-off (cumulative flooring) and 151 of the 67 %. Prorated:
round(1 × 0.157) = 0, so the amount-off is dropped (DSC-08; the description shows only "with 67.0%
off"). round(151 × 0.157) = 24 survives, and the credit is -(35 - 24) = -11 on both sides.

## 2. Category

### A. Flexible immediate invoice: the credit lists the carried discounts that survive DSC-08 and are still on the invoice (1)

**Target rule.** Flexible mode, immediate invoice (`always_invoice`). The credit line lists its
discounts at 0, chosen in this order:

1. The invoice has no discount: nothing.
2. The billed line carried no discount: the invoice's discounts.
3. No carried discount survives DSC-08 (its prorated amount rounds to 0): nothing.
4. Some surviving carried discounts are still on the invoice: those, in subscription order.
5. A carried discount is still on the invoice, but it was dropped: the invoice's discounts.
6. Otherwise (the survivors are spent once coupons, or coupons replaced by one passed to the
   preview): the surviving one if there is exactly one, else the invoice's discounts.

This rule fits 148 of 148 flexible immediate credits (dev and hold-b4). Fixtures that pin each step:

- Step 4 with a proper subset: **hold-b4-s1-089** only. Both coupons are active, the amount-off
  is dropped and the 67 % survives, and the target lists the 67 % alone. Its non-immediate twin
  hold-b4-s1-053 (default behaviour; $1.64 share 1 → 0, 19 % survives) lists the dropped coupon
  first, as all non-immediate flexible previews do (`top[0]`; also hold-b4-s1-047 and dev
  dev-b3-flexible-a4-pct-then-off). The filtering therefore belongs to immediate invoices only.
- Step 4 with every survivor on the invoice: dev wide-025, wide2-048/-137/-158/-193,
  dev-t2-c-forever-forever-none; hold-b4-s1-048, -s3-067; and the one-carried cases (d-pct20-always,
  wide-003, wide3-041, ...). Mixed with a spent once coupon: dev wide-088, wide2-036, wide3-080,
  wide3-163, dev-t2-c-once-forever-none; hold-b4-s2-040, -s3-062.
- Step 5: dev **dev-brk-two-carried-one-surviving** (0.1 % share 1 → 0 is dropped, the spent
  $5 once coupon survives, and the 0.1 % is listed) and wide2-157; also hold-b4-s3-019.
- Step 6, one survivor: dev-t2-b-always-flexible-_, dev-t2-c-{forever,once}-{forever,once},
  wide3-175, wide3-254; hold-b4-s1-102, -s2-061, -s3-003/-027/-031. Two survivors: the four
  dev-t2-c-_-forever-{forever,once} cases (the passed coupon is listed).
- Step 3: dev-t2-d-flexible-*-always_invoice (6), dev-brk-off1-zero-share-always; hold-b4-s1-056.
  Step 1: dev-t2-c-once-none, wide2-014/-045/-053, wide3-048/-140/-160/-251/-267/-287; 9 hold-b4.
  Step 2: wide-117, wide2-127/-249, dev-t2-b-always-flexible-none; hold-b4-s3-055.

**Clone.** `clone/billing.ts:501-508` (the table of NOTES.md pass 4, lines 167-173). After the
`mine.length === 0` test, the choice depends only on how many discounts the billed line carried
(`carried`, set to `all.length` at `billing.ts:258`): one carried means the survivors (`mine`,
`billing.ts:240`), two mean the invoice's (`top`, `billing.ts:508`). For hold-b4-s1-089 it takes
`top` and so lists the dropped amount-off. The clone never intersects the survivors with the
invoice's discounts.

**Dev evidence: not enough to choose, and the rules pointed the right way.** No dev fixture has
two carried discounts that are both still on the invoice with exactly one surviving. All three
two-carried, one-surviving cases (one dev breaker, wide2-157, and s3-019 in this batch) have a
spent once coupon as the survivor. Scored symbolically, the clone's table and the rule above both
fit every dev case. The clone's table fails only s1-089. The rules.json DSC-07 wording fails 34 of
the 148. Two things should have steered the builder:

- DSC-08 as written ("absent ... in an immediate invoice, from its discount list") predicts
  s1-089 correctly. The clone's table overrides it.
- NOTES.md pass 4 (lines 175-176) flagged this exact gap: "the holdout may hold combinations (two
  carried, one surviving) it does not cover".

Under `WIDE_DISTRIBUTION_V2` this shape has a probability of about 0.08 % (166 in 200,000
simulated draws, seed 777): about 0.25 expected among the 300 wide3 probes, and 1 drawn here.

## 3. Proposed rule statements (proposals only)

- **DSC-07 (correct):** "Flexible mode, immediate invoice: proration lines list their discounts
  at 0. The credit line lists nothing when the invoice has no discount. It lists the invoice's
  discounts when the billed line carried none. It lists nothing when no carried discount survives
  DSC-08. Otherwise it lists the surviving carried discounts still on the invoice, in subscription
  order. If there are none, it lists the invoice's discounts when a carried discount is still on
  the invoice, else the single surviving carried discount (a spent once coupon, or one replaced by
  a coupon passed to the preview), else the invoice's discounts. A non-immediate flexible preview
  lists the invoice's first discount, a dropped one included." Checked: 148/148 immediate; the
  last sentence holds for all 26 non-immediate cases with two invoice discounts.
- **DSC-08 (clarify):** add "A dropped discount stays in the list only when DSC-07 falls back to
  the invoice's discounts (dev-brk-two-carried-one-surviving, wide2-157). It also arises away from
  the period end: a 1-cent share at r/P < 0.5 is dropped." Checked: the computed survivors agree
  with the target's "(with ...)" text on all 843 flexible credits.

## 4. Proposed dev probes (WideInput shapes)

All `kind: "wide"`, `billing_mode: "flexible"`, `interval: "month"`, `start: 1791158400`
(P = 2678400), `items: [{amount: 1000000, quantity: 1}, {amount: 100, quantity: 1}]`,
`change: {item: 1, amount: 300, interval: null, quantity: null, proration_behavior: "always_invoice"}`.
The shares and prorated amounts below were computed with the clone's own allocation.

1. `coupons: [{amount_off: 500, forever}, {percent_off: 50, forever}]`, `offset: 2008800`
   (r/P = 0.25). Item 1 shares 1 / 50, prorated 0 / 13. Expected credit list: [50 %] only. The
   clone gives both. This is the s1-089 shape.
2. Same with the coupon order reversed: shares 50 / 1, prorated 13 / 0. Expected: [50 %] (order check).
3. Probe 1 with `offset: 669600` (r/P = 0.75): prorated 1 / 38, both survive. Expected: both (control).
4. Probe 1 with the 50 % as `once` (spent on the first invoice): the survivor is spent and the
   dropped amount-off is still active. Expected: [amount-off] (step 5, multi-item twin of the dev
   breaker).
5. Probe 1 with `discount: {percent_off: 10, duration: "forever"}`. This is open: the rule above
   predicts [50 %, the carried survivor], while "two carried → the invoice's discounts" predicts
   [10 %]. No fixture pins it (about 0.04 % of V2 draws).
6. Probe 1 with `proration_behavior: null` and `create_prorations` (controls: expected [amount-off],
   the invoice's first discount, dropped or not).

## 5. Evaluator-side observations

- The failure itself is not an evaluator problem. `noise` is empty, no field involved is masked or
  toleranced, and the replay is deterministic and reproduces `failures.json`. Canonical IDs map
  di#1/di#2 identically on both sides: di#1 is the amount-off on both, as the charge line's
  "($647.29 off)" shows.
- Rule tags: `rulesForWide` (`probes.ts`) tags DSC-08 only when `offset >= len - 1`. s1-089 is a
  DSC-08 case with a mid-period offset, so its failure is charged to DSC-07 alone. Small-share drops
  are never tagged DSC-08. Also unrelated to this failure: the INV-01 tag uses `< 50`, while INV-01
  states a minimum of 56.
- Driver nit, harmless (both sides run the same code): `wide.ts` names only three plans and says
  "one to three items", but V2 draws up to four. The fourth item is named "Plan", as in s1-089.
- Tooling friction (no effect on verdicts): `guard-oracle.sh` blocked a Glob on `spent/hold-b4/`
  ("must scope searches to fixtures/dev/ or clone/"). It also blocked `fixtures/dev` without a
  trailing slash, a read-only `cat` of `.claude/agents/analyst.md` in a compound command, and a
  read-only Python `open(...)` ("cannot modify the evaluator").

## Summary

1. 1 failure of 473 (hold-b4-s1-089), one root cause; the amounts are right and the credit line's discount list is wrong.
2. A, flexible immediate credit list (1 case): the target lists only carried discounts that survive DSC-08 and are still on the invoice.
3. The clone picks by the number of carried discounts (`clone/billing.ts:501-508`), so it lists a dropped amount-off.
4. The proposed DSC-07 rule fits 148/148 flexible immediate credits (dev and hold-b4); the clone's table fits 147, rules.json DSC-07 fits 114.
5. Confidence on the s1-089 step is medium-high: one target case pins it, DSC-08's wording predicts it, and its non-immediate twin s1-053 confirms the immediate-only scope.
6. Confidence on the full fallback order is medium: probe 5's combination (passed coupon, two carried, one survivor) is unobserved.
7. Dev evidence was insufficient: no dev case had two active carried discounts with one dropped; the only dev two-carried, one-surviving case had a spent once coupon as the survivor.
8. The builder's own NOTES (pass 4) flagged this gap; rules.json DSC-08 already pointed the right way.
9. Proposals: correct DSC-07, clarify DSC-08; six probe designs in section 4, probe 1 being the direct pin.
10. No evaluator problem; there are tagging gaps (DSC-08 only at the period end, the INV-01 threshold at 50) and guard-hook friction.
