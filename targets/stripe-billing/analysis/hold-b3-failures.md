# Holdout batch 3 (hold-b3-001..473): the 7 failures

Method: each case replayed on the clone (`startCloneProcess` on a free port, `POST /__reset`
between cases, the adapter's `run` with the fixture's `input`), diffed with the harness's `diff`
and `blocking` under `policy.json`. Replaying the whole batch (473 cases) gives exactly the 7 IDs
of `failures.json` and no crash. Hypotheses were then checked by script against every dev fixture
(976) and every hold-b3 fixture, not only the failures. All 7 failures are classic billing mode.

## 1. Failing cases

| Case        | First differing fields                                | Expected => actual                                                                                                     | Category |
| ----------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------- |
| hold-b3-086 | lines[0].amount (credit); subtotal, total, amount_due | -65291 => -65292; total 6397136 => 6397135                                                                             | A        |
| hold-b3-135 | lines[0].amount (credit); subtotal, total, amount_due | 0 => -148; total 1133640 => 1133492                                                                                    | A        |
| hold-b3-136 | lines[0].amount (credit); subtotal, total, amount_due | -80 => -89; total 26048730 => 26048721                                                                                 | A        |
| hold-b3-310 | lines[0].amount (credit); subtotal, total, amount_due | -22583154 => -22583165; total 588674245 => 588674234                                                                   | A        |
| hold-b3-282 | lines[1] (all fields), lines.total_count              | 2 lines => 3: clone inserts "Remaining time on Plan New after 17 Dec 2026" at 0 before the renewal "0 × Plan New" line | B        |
| hold-b3-300 | lines[1] (absent => present), lines.total_count       | 1 line (credit only, always_invoice) => 2: extra 0 "Remaining time on Plan New after 15 Apr 2027"                      | B        |
| hold-b3-393 | lines[1..3], lines.total_count                        | 3 lines => 4: extra 0 "Remaining time on Plan New after 05 Aug 2027", later lines shifted by one                       | B        |

In category B every total matches (the extra line is 0); only the line list differs.

## 2. Categories

### A. Classic credit: every discount of the billed line counts, even one the item got 0 from (4)

**Target rule.** In classic mode the unused-time credit is
`-round_half_away(net × r / P)` where `net` is the old item's amount `b` (unit × quantity) after
applying, in subscription order, _every_ discount that was on the subscription when the period
was billed, to that item alone: an amount-off in full (`min(amount, left)`), a percent-off as
`round(pct × left)`, clamped at 0. What share of each coupon the item actually got on the
multi-item first invoice does not matter, including a share of 0.

- hold-b3-086: forever $0.03 off, 3 items; the item got 0 of it on the first invoice (allocation
  0/2/1). `218750 × r/P = 65291.94`, `(218750 - 3) × r/P = 65291.05`: observed -65291.
- hold-b3-136: once $0.17 off, item share 0: `174 r/P = 89.14` vs `157 r/P = 80.44`: observed -80.
- hold-b3-310: once $0.09 and forever $0.02, both shares 0: observed -22583154 = `(b - 11) r/P`.
- hold-b3-135: once $15.07 off (share 0) then 77 % forever on an item of 1107: `1107 - 1507`
  clamps to 0, so the credit is 0; the clone, applying only the 77 %, gives -148.
- Checked on all 359 classic previews with a credit line (219 dev, 140 hold-b3): this rule fits
  359 of 359. The clone's reading ("only discounts with a non-zero share") fits 355 (fails the 4
  above). The "allocated share" reading fails 37 (dev: wide-101, wide-133, wide-136, wide2-027,
  wide2-051, wide2-140, wide2-198, wide2-248, wide2-276, wide2-280, wide2-281, wide3-026,
  wide3-046, wide3-088, wide3-108, wide3-164, wide3-170, wide3-257). Applying the coupons in
  reverse order fails 17, among them dev wide2-027/-040/-051/-084/-198/-281/-294, wide3-026/-189:
  subscription order is pinned by dev.

**Clone.** `clone/billing.ts:223` filters the billed discounts to `amount !== 0`, and
`billing.ts:229-234` computes `D` from that filtered list only. The comment at `billing.ts:227-229`
and NOTES.md pass 5 point 4 state "the prorated amount still uses the non-zero ones" as a finding.

**Dev evidence: not enough.** Only two dev cases have a coupon with a zero share on the credited
item, wide3-054 (100 % then 66 %) and wide3-249 ($3,492.68 then $0.04 on an item of 688), and in
both the first coupon already takes the whole item, so both readings give 0. The filter was not
required by any dev case; the simpler "apply all" reading fit every dev case equally well, so the
builder made an unforced choice that dev could not refute.

### B. Classic: no remaining-time line for a new item billed at 0 (3)

**Target rule.** In classic mode, when the changed item's new amount (unit amount × new quantity)
is 0, the preview has no "Remaining time" line: the credit line alone (plus the renewal lines,
where the "0 × Plan New" renewal line is kept). Flexible mode keeps a 0 "Remaining time" line.

- hold-b3-282, -393 (default behaviour) and -300 (always_invoice): quantity 0 with a new price,
  classic, no charge line.
- Over all classic previews with a credit line and no interval change (dev + hold-b3), a
  remaining-time line is present in 325 of 325 cases with new amount > 0 and in 0 of 3 with new
  amount 0. Classic 0-amount charge lines with a positive new amount are kept (dev
  dev-brk-pct100-half-classic, dev-t2-d-classic-_-end1/2-_, wide-019, wide-136, wide3-117, ...):
  the rule is about the item's amount, not the line's.
- Flexible quantity-0 changes all keep the 0 line: dev b-qty-zero, wide3-015,
  dev-brk-qty-to-zero-multi-always; hold-b3-007, -039, -118, -239, -297.
- Mirror of the existing credit-side behaviour (no credit line for an old item billed at 0,
  dev-brk-qty0-item, flexible only).

**Clone.** `clone/billing.ts:368-372` computes `n` but returns early only for `r2 <= 0`; the line
is pushed at `billing.ts:393` whatever `n` is, in both modes.

**Dev evidence: none.** No dev fixture changes a classic item to quantity 0 with prorations; every
dev quantity-0 change is flexible and keeps the line, which points the builder the wrong way.
`WIDE_DISTRIBUTION_V2` produces this case with probability about 0.3 × 0.4 × 1/21 × 0.85 ≈ 0.5 %
(1.4 expected among the 300 wide3 probes, 0 drawn; 3 among 473 here).

Untested within B: a classic quantity-0 change with coupons (whether a once coupon is then
spent, listed, or applied to the renewal).

## 3. Proposed rule statements (proposals only)

- **DSC-04 (correct):** "Classic mode: proration lines are not discountable. The credit is
  -round_half_away(net × r/P), where net is the old item's amount after applying every discount
  that was on the subscription when the credited period was billed, in subscription order, to that
  item alone: an amount-off in full, a percent-off as round(pct × what is left), never below 0.
  The share each discount got on the billing invoice is irrelevant, including a share of 0. The
  charge prorates first and subtracts the prorated discount after." Checked: 359/359 classic credits.
- **PRO-11 (new):** "Classic mode: when the changed item's new amount (unit amount × new
  quantity) is 0, the preview has no remaining-time line (default, create_prorations and
  always_invoice); the renewal still lists the item at 0. Flexible mode keeps a remaining-time
  line at 0. A 0 remaining-time line for a positive new amount (rounding, 100 % coupon) is kept in
  both modes." Checked: 325/325 + 3/3 classic, 8/8 flexible quantity-0.
- **ITM-01 / PRO-08 (extend):** add "An old item billed at 0 gets no credit line" (today only in
  NOTES pass 5; pinned by dev-brk-qty0-item, flexible only).
- **MOD-01 (extend):** add "and by the remaining-time line of a new item billed at 0 (PRO-11)".

## 4. Proposed dev probes (WideInput shapes)

All `kind: "wide"`, `interval: "month"`, a start mid-month, `offset` about half the period (so
the difference is many cents, not a rounding accident) unless stated.

Category A (classic; pair each with the same input in `flexible` as a control):

1. `items: [{amount: 1000, quantity: 1}, {amount: 1000000, quantity: 1}]`,
   `coupons: [{amount_off: 500, duration: "forever"}]`, `change: {item: 0, quantity: 2}`.
   Item 0's share is floor(500 × 1000 / 1001000) = 0; expected credit ≈ -250, not ≈ -500.
2. Same items, `coupons: [{amount_off: 500, duration: "once"}]` (once variant).
3. Same items, `coupons: [{amount_off: 1500, duration: "once"}, {percent_off: 50, duration: "forever"}]`:
   amount-off larger than the item, then a percent: expected credit 0 (clamp, then 50 % of 0).
4. Same items, `coupons: [{percent_off: 50, duration: "forever"}, {amount_off: 400, duration: "forever"}]`:
   zero-share amount-off after a percent (order check).
5. Three items `[{100, 1}, {500000, 1}, {500000, 1}]`, `coupons: [{amount_off: 3, ...}]`, offset 1
   and offset `len - 1`: the cent-level edge as in hold-b3-086.

Category B (classic; each also in flexible):

6. `items: [{amount: 2000, quantity: 2}]`, `coupons: []`, `change: {item: 0, amount: 5000, quantity: 0}`,
   behaviour null, `create_prorations`, `always_invoice` (three probes).
7. Same with `amount: null` (quantity-only change to 0).
8. Two items, change item 0 to quantity 0, behaviour null: the renewal keeps "0 × ..." and the other item.
9. Item 6 with `coupons: [{percent_off: 20, duration: "forever"}]` and, separately,
   `change.discount: {amount_off: 300, duration: "once"}`: pins discounts and once-coupon
   spending when no charge line exists (not covered by any fixture yet).
10. Control: classic `change.quantity: 1` with `offset: len - 1` (a positive amount whose charge
    rounds to 0: the line must stay).

## 5. Evaluator-side observations

- None of the 7 looks like an evaluator problem. `noise` is empty in all 473 fixtures; replaying
  the batch reproduces exactly `failures.json`; the differences are amounts the target computes
  differently (A) or a line the target omits (B), with no policy-masked field involved. Driver
  and `recorded_with` (API 2026-08-26.dahlia, stripe-node 22.6.2) are the same on both sides.
- Fixture `rules` tags do not name a rule that covers either category (no tag can, since neither
  rule exists); after adding PRO-11, the tagger should attach it to classic quantity-0 changes.
- Tooling, not verdicts: `harness/hooks/guard-oracle.sh` blocks the analyst's `Write` to `/tmp`
  (it allows analyst writes only under `analysis/`), although `analyst.md` asks for throwaway
  scripts in `/tmp`. It also matches the word "fixtures" in a Bash call's `description` field
  (`fixtures/?$`), so a harmless description such as "List spent batch fixtures" blocks the call.

## Summary

1. 7 failures of 473, all classic billing mode, two root causes; no evaluator problem found.
2. A, classic credit discounts (4: hold-b3-086, -135, -136, -310): Stripe applies every billed
   discount to the credited item, a zero-share one included; the clone drops zero-share ones.
3. A, confidence high: one rule fits 359/359 classic credits (219 dev, 140 hold-b3).
4. A, dev evidence insufficient: the only two zero-share dev cases cannot tell the readings apart.
5. B, classic charge for an item at 0 (3: hold-b3-282, -300, -393): Stripe omits the
   remaining-time line; the clone emits one at 0.
6. B, confidence high on the rule (325/325 and 3/3 classic, 8/8 flexible counter-cases);
   medium on its interaction with coupons (unobserved).
7. B, dev evidence absent: no classic quantity-0 change in dev; the flexible ones point the other way.
8. Proposals: correct DSC-04, add PRO-11, extend ITM-01/PRO-08 and MOD-01.
9. Ten probe designs in section 4 pin both categories without this batch.
10. Clone sites: `clone/billing.ts:223` (A) and `clone/billing.ts:368-372` (B).
