# Holdout batch 1 (hold-001..473): the 25 failures

Method: each failing case replayed on the clone (port 4677, `/__reset` between cases) and diffed
with the harness's own `diff` and `policy.json`. The diff counts match `holdout-verdict.json` for
all 25. Hypotheses were then checked against every dev and holdout fixture, not only the failures.
"Dev" below means the dev fixtures the builder had. The `wide2-*` fixtures were being recorded by
another session while this analysis ran (recorded_at 2026-10-01 after 11:43Z, after the builder's
last run), so they are listed apart as "new dev".

## 1. Failing cases

| Case     | First differing field(s)                           | Expected => actual                                                                      | Category |
| -------- | -------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- |
| hold-003 | lines[0].description                               | "Unused time on 4 × Plan A after ..." => "... (with discounts) after ..."               | D        |
| hold-019 | amount_due; discounts                              | 116770 => 118054; [di] => []                                                            | B1       |
| hold-048 | amount_due; lines                                  | 257046 => 0; one full-year line => no line                                              | E        |
| hold-059 | first_invoice.amount_due; preview.starting_balance | 0 => 25; 25 => 0                                                                        | F        |
| hold-085 | lines[0].discount_amounts                          | [] => [{di#1, 0}]                                                                       | C        |
| hold-092 | lines[3/4].discount_amounts[1].amount              | 965/5705 => 964/5706                                                                    | A        |
| hold-102 | discounts; lines[*].discount_amounts               | [di] => []; [{di,0}] => []                                                              | B2       |
| hold-111 | discounts; lines[*].discount_amounts               | [di] => []; [{di,0}] => []                                                              | B2       |
| hold-137 | discounts; lines[0].discount_amounts               | [passed once] => []; [passed] => [two subscription coupons]                             | B2       |
| hold-148 | amount_due; discounts                              | 10373 => 12344; [di] => []                                                              | B1       |
| hold-150 | discounts; total_discount_amounts                  | [di] => []; [{di,0}] => [] (line diffs are ID renumbering, then C)                      | B2 + C   |
| hold-154 | lines[0].discount_amounts                          | [] => [{di#1, 0}]                                                                       | C        |
| hold-173 | lines[2/3].discount_amounts[0].amount              | 14586/24042 => 14587/24041                                                              | A        |
| hold-181 | lines[2/3].discount_amounts[0].amount              | 600/91 => 601/90                                                                        | A        |
| hold-217 | lines[0].discount_amounts[0].discount              | carried once coupon => invoice's coupon                                                 | C        |
| hold-230 | lines[0/1].discount_amounts[0].amount              | 14822/696 => 14823/695                                                                  | A        |
| hold-294 | lines[0].amount (credit)                           | -1086 => -1087                                                                          | A        |
| hold-373 | lines[0].amount (credit)                           | -364969 => -364970                                                                      | A        |
| hold-377 | lines[0].description; lines[0].discount_amounts    | no "(with discounts)" => "(with discounts)"; [] => two at 0                             | D        |
| hold-386 | lines[0].discount_amounts                          | [] => [{di#1, 0}]                                                                       | C        |
| hold-399 | lines[0].discount_amounts                          | [] => [{di#1, 0}]                                                                       | C        |
| hold-400 | amount_due; discounts                              | 52987 => 54455; [di] => []                                                              | B1       |
| hold-412 | lines[2/4].discount_amounts[0].amount              | 199/385 => 200/384                                                                      | A        |
| hold-434 | lines[2/4].discount_amounts[0].amount              | 32266/40193 => 32267/40192                                                              | A        |
| hold-473 | lines[0]; amount_due                               | "Remaining time on 10 × Plan New (with $14.11 off)" 755855 => absent; 1581864 => 826009 | E        |

Counts: A 8, B 7 (B1 3, B2 4), C 5 (hold-150 counted under B2), D 2, E 2, F 1. Total 25.

## 2. Categories

### A. Percent-off allocation across lines (8)

Stripe: the invoice amount of a percent-off coupon is round(pct × S), with S the sum of what is
left of the discountable lines. That amount is spread like an amount-off: floor(amount × line /
S) per line, remainder one cent per line from the last line. The clone floors pct × line per
line. A flexible credit carries the discount its item got on the first invoice, so the same
cent moves the credit (hold-294, hold-373: the credited item gets one more cent of discount under
Stripe's allocation; recomputing with it gives -1086 and -364969 exactly).

Proof: across all 95 multi-line discounted invoices (dev and holdout), the proportional rule
matches 95 of 95. The floor-per-line rule matches 89; it fails on exactly hold-092, 173, 181, 230,
412, 434. Example hold-230: lines 32940 and 1545 at 45 %: total 15518; Stripe 14822 + 696, clone
14823 (= 32940 × 0.45 exactly) + 695.

Clone: `clone/billing.ts:65-70` (percent branch of `allocate`). The same function allocates the
first invoice (`clone/api.ts:116`), which feeds the credit (`clone/billing.ts:208,219`).

Dev evidence: not enough. The 7 dev invoices with a percent-off on several lines (wide-002, 021,
083, 084, 099, 112, 140) give the same result under both rules. The rules split on about 10 % of
random multi-item percent-off invoices; NOTES.md records "floor(base x pct)", which fits dev.

### B. A once coupon passed to the preview (7)

Stripe (rule as observed on all 24 fixtures that pass a once coupon to the preview):

- B1, the change prorates nothing (same price and quantity: hold-019, 148, 400): the coupon
  discounts the renewal invoice like any coupon. It appears in `discounts` and
  `total_discount_amounts` and is allocated over the renewal lines.
- B2, an immediate invoice (`always_invoice`: hold-102, 111, 137, 150): the coupon is listed in
  `discounts` and `total_discount_amounts` at 0, and at 0 on the proration lines.
- With prorations in a non-immediate preview (17 fixtures, 6 of them dev): it discounts only the
  remaining-time charge. It is not in `discounts` and the renewal is not discounted. The clone
  handles this case correctly.

Clone: `clone/billing.ts:384-385` drops every once coupon from the invoice's discounts
(`top`), whatever the plan. B2 also needs the list fix of C in flexible mode (hold-150).

Dev evidence: none for B1 or B2. The 6 dev fixtures that pass a once coupon (wide-007, 013, 023,
027, 032, 129) all have a real change and no `always_invoice`, so "never on the invoice" fit them.

### C. Discount list of the credit line in an immediate flexible invoice (5)

Stripe, observed table (flexible, `always_invoice`). "Carried" means the credited item's discounts
from the first invoice. "Inv" means the preview invoice's discounts.

| carried                              | inv                 | credit lists            | fixtures                                         |
| ------------------------------------ | ------------------- | ----------------------- | ------------------------------------------------ |
| = inv (forever)                      | non-empty           | inv                     | wide-025, wide-090, d-pct20-always, many holdout |
| used once only                       | empty               | nothing                 | hold-085, 154, 386, 399; new dev wide2-014       |
| used once only                       | passed coupon       | the carried once coupon | hold-150, hold-217                               |
| forever + used once                  | forever (or passed) | inv                     | wide-088, hold-357, hold-397, wide-005           |
| forever, replaced by a passed coupon | passed              | inv                     | hold-137                                         |
| none                                 | passed              | inv                     | wide-117                                         |

The charge lists its own applied discounts, as the clone already does. Proposed rule: an
immediate flexible invoice with no discount lists nothing on its proration lines. Otherwise the
credit lists the invoice's discounts, unless everything it carries is a used once coupon; then it
lists those coupons.

Clone: `clone/billing.ts:418-420`. The clone lists the carried once coupon when the invoice has no
discount (should list nothing), and lists the invoice's discounts when it has one (should list
the carried once coupon).

Dev evidence: not enough at build time. No dev fixture had an immediate flexible invoice whose
credit carried only a used once coupon. New dev wide2-014 now pins the "nothing" row. No dev
fixture pins the hold-150/217 row.

### D. Flexible credit whose discounts prorate to 0 (2)

Stripe: in flexible mode, a carried discount whose prorated amount round(D × r / P) is 0 (here
1 second left: hold-003, hold-377) is not applied to the credit. The description has no
"(with ...)", and in an immediate invoice the line lists no discount (hold-377 lists [] although
the invoice has two). Classic mode keeps the label: wide-047 (dev), hold-094 and hold-307 show
"Unused time ... (with 49.0% off)" on a 0 credit. Classic computes round((b - D) r / P) in a
single step, so it has no per-discount prorated amount.

Clone: `clone/billing.ts:224` labels with every carried discount and `:235` returns them all as
the line's own. The equivalent rule exists for the charge only (`:324`, learnt from wide-117).

Dev evidence: partial. wide-117 gave the charge-side rule. No dev flexible credit with a carried
discount and a remaining time near 0 existed, so applying it to the credit was an inference
nobody tested. Confidence: medium-high (2 cases, consistent with the charge rule and with the
classic contrast).

### E. Interval change with proration_date exactly at the old period end (2)

Stripe:

- Flexible, month to year at offset = period length (hold-473): no credit line (zero remaining
  time). There is a "Remaining time on ..." charge from proration_date to the new period end,
  which stays anchored on the start (one year), with the coupon prorated: 757146 - 1291 = 755855.
  It is followed by the renewal at the new price.
- Classic, month to year at the period end (hold-048): the cycle still resets. The invoice holds
  one full-year line from the clock time, and no credit line.
- A credit line with zero remaining time is omitted. With 1 second left it is kept at 0
  (wide-047, classic).

Clone: `clone/billing.ts:295` sets `prorates = ... && prd < sub.period_end`, which uses the old
period end, so nothing is prorated. `:393-397` then emits a reset line only for items that have a
proration line, so hold-048 is left with no lines at all.

Dev evidence: none. The six dev cases at the period end (b-up-at-period-end, wide-017, 036, 070,
110, 122) have no interval change, so "at the period end there is nothing to prorate" fit them
all.

### F. Minimum charge amount (1)

Stripe: a first invoice of 25 cents (1621 - 1596 once coupon) is not charged. Its `amount_due`
is 0 and its status `paid`, and the 25 cents go to the customer balance. The preview then shows
`starting_balance` 25 and adds it to `amount_due` (40197 + 25 = 40222). This matches Stripe's
documented minimum charge amount (USD 0.50). hold-059 is the only fixture with a first invoice
between 1 and 49 cents.

Clone: `clone/api.ts:154-158` charges any positive total. `clone/objects.ts:74,84` and `:168`
(`starting_balance: 0`) have no customer balance.

Dev evidence: none. Confidence on the rule: high. The exact threshold (50) is inferred from
Stripe's documentation, not from fixtures.

## 3. Proposed rule statements (proposals only)

- DSC-01 (correct): "A percent-off coupon takes round(percent × sum) from the discountable
  lines it applies to and allocates that amount across them like an amount-off: floor of the
  proportional share, with the remainder one cent per line from the last line. This includes the
  first invoice, whose allocation sets the discount a flexible credit carries."
- DSC-05 (correct): "A once coupon on the subscription discounts its first invoice only. A once
  coupon passed to the preview: (a) with prorations and no immediate invoice, discounts only the
  remaining-time charge and is not listed in the invoice's discounts; (b) when the change
  prorates nothing, discounts the renewal invoice and is listed; (c) in an immediate invoice, is
  listed in discounts and total_discount_amounts at 0 and on the proration lines at 0."
- DSC-07 (new): "In an immediate flexible invoice with no discount, proration lines list no
  discount. Otherwise the credit line lists the invoice's discounts at 0, unless everything it
  carries is a used once coupon, in which case it lists those coupons."
- DSC-08 (new): "Flexible mode: a discount carried by a credit line whose prorated amount
  rounds to 0 is not applied: it is absent from the line's description and, in an immediate
  invoice, from its discount list. Classic mode keeps the label."
- INT-02 (new): "An interval change with proration_date at the current period end still
  changes the subscription. Flexible: a remaining-time charge from proration_date to the new,
  start-anchored period end, then the renewal. Classic: the cycle resets and the invoice bills a
  full new period from the clock time. A credit with zero remaining time is omitted."
- INV-01 (new): "An invoice whose amount due is above 0 and below 50 cents is not charged:
  amount_due 0, status paid, and the amount is added to the customer balance. The next invoice
  shows it as starting_balance and adds it to amount_due."

## 4. Proposed dev probes (WideInput shapes)

- A: `items` of 2-3 lines and one forever percent coupon, picked so that the two allocations
  differ, with a no-op change (`amount: null, quantity: null`). Examples found offline:
  `[{7009,1},{1371,9},{9488,6}]` at 22 %, `[{1065,4},{4809,3},{4156,7}]` at 26 %,
  `[{3880,3},{1459,3},{2578,4}]` at 43 %. Repeat the same items with a real change on the item
  whose allocation moves, in flexible mode, so the credit shows the cent too.
- B: one item and a once amount-off `discount` passed to the preview, with (i) a no-op change ×
  {flexible, classic} × {default, create_prorations}, and (ii) a real change with
  `always_invoice` × {flexible, classic} × subscription coupons {none, forever, once}.
- C: flexible, `always_invoice`, a real change, subscription coupons {once}, {once, forever},
  {forever}, {forever, forever} × preview `discount` {none, once, forever}. 12 probes, one item.
- D: flexible, subscription coupons {percent}, {amount}, {percent, amount}, offset = len - 1
  and len - 2, × {default, always_invoice}. Add the same in classic as a control.
- E: single item, interval change month to year and year to month, offset = len, × {flexible,
  classic} × {no coupon, forever coupon}. Add offset = len - 1 as a control.
- F: one item with a once amount-off leaving 1, 25, 49, 50 and 51 cents on the first invoice
  (for example amount 1621 with coupons 1620, 1596, 1572, 1571, 1570), then any real change.

## 5. Evaluator-side observations

- No noise. None of the 25 cases declares noise paths, and every difference is reproduced
  deterministically. None of the failures depends on wall-clock time.
- Rule labels are not diagnostic. `rulesForWide` / `rulesFor` (`probes.ts:79-104`) tags every
  non-`none` probe with PRO-01..04, even no-op changes (18 % of the distribution: 81 of 525
  holdout and 18 of 136 dev wide probes change nothing). So hold-019, 148, 230, 400 count against
  proration rules although nothing is prorated. Renewal-line allocation errors (A) also count
  against PRO-01..05. Per-rule failing counts in the verdict should not be read as localisation.
- Missing rules. Minimum charge (F) and the percent-off allocation (A) had no precise statement,
  and the first-invoice fields (`first_invoice`) are scored without a rule naming them.
- Canonical ID renumbering inflates diff counts. In hold-150, the missing invoice-level discount
  shifts every `di#n` on the lines, so lines whose list is correct show as different. This is a
  reporting artefact, not a false failure (the case fails on `discounts` anyway).
- Concurrent recording. While this analysis ran, another process was running
  `npm run record stripe-billing --only wide2-001..300` and a `--rerecord uf-cancel`, rewriting
  `fixtures/dev`, `fixtures/holdout` and `fixtures.lock`. The `hold-*` files were unaffected
  (diff counts identical to the verdict). Some `wide2-*` fixtures were hash-split into the
  holdout.
