# Clone notes: stripe-billing

Builder notes. The recorded behaviour is the specification; these notes record how each rule was
read from the dev fixtures, what was predicted to flip, and what did flip.

## Pass 1: the preview engine (PRO-_, PER-01, DSC-_, INT-01, ERR-01, MOD-01, ITM-01)

Baseline: 0 of 387 (empty server).

Rules as read from the dev fixtures (checked offline against every logic fixture before coding):

- Period: anchored on the start, same day of month (clamped), same time of day (PER-01).
- r = period end - proration date, P = period length, e = proration date - period start.
- No coupon: credit = -round_half_away(b r / P) on exact integers; flexible charge =
  Math.round(n (1 - e / P)) in floating point; classic charge = round_half_up(n r / P). 142 of 142
  single-item, no-coupon fixtures agree (PRO-01..04).
- A price change without a quantity bills quantity 1 (PRO-10).
- Coupons (DSC-04 / MOD-01): classic credit = -round((b - D) r / P) with D the discount the item got
  on the invoice that billed the period; flexible credit = -(round(b r/P) - sum round(D_k r/P)).
  These two differ by one cent in u-classic-off-once-q4 / u-flex-off-once-q4. Charge =
  prorated n minus the prorated discount of the new state (D2 = discounts applied to the new
  item alone). All single-coupon dev fixtures agree with these (several formulas are equivalent on
  the dev set).
- Discount allocation on invoice lines: discounts apply one after another in subscription order;
  percent-off per line is floor(base x pct), amount-off per line is floor(total x base / sum);
  the rounding remainder goes to the last line.
- once coupons: they discount the credited period (the credit carries them) and a once coupon passed
  to the preview discounts the remaining-time charge, but never the renewal lines and never appear
  in the invoice's `discounts` (DSC-05).
- A coupon passed to the preview replaces the subscription's discounts for the new state.
- discount_amounts on proration lines (lookup-like, observed only): classic = every invoice-level
  discount at 0; flexible = the first invoice-level discount at 0 (all of them for an immediate
  invoice), or, when the invoice has no discount, the discounts the line itself carries.
- Immediate invoice (always_invoice, or a classic interval change): created = clock time,
  period_start = period_end = clock time, auto_advance false, no next_payment_attempt. A classic
  interval change bills the new price for a full period from the clock time and has no
  remaining-time line. At the period end, or without any change, there is nothing to prorate and
  the preview is the renewal invoice.
- Flexible interval change: the new period is anchored on the current period start; a proration
  date at or past the new (shorter) period end is rejected (param null).

Prediction: most single-item logic fixtures flip; multi-coupon and multi-item fixtures partly.

Result: verify 360 of 387. All 8 lifecycle fixtures passed too (LIF-*: renewal at the period
end, payment an hour later, retries, cancel at period end, cancel now with a draft
`subscription_cycle` credit invoice, trial with a zero "Free trial for" invoice). 9 logic
fixtures failed: fresh2-081, fresh2-141, wide-025, wide-101, wide-117, wide-122, wide-133,
wide-136, wide-138.

## Pass 2: the 9 logic failures (PRO-01..04 group, DSC-04, ITM-01)

Read from those fixtures:

- Allocation remainder: one cent per line from the last line backwards (wide-122: floors
  301/77/1229, remainder 2, observed 301/78/1230; wide-138, wide-025 follow from it).
- Classic credit: the coupons apply to the credited item alone, so an amount-off coupon counts
  in full, not its share of a multi-item invoice (wide-101, wide-133, wide-136).
- Classic charge: a percent-off is taken on the prorated amount (fresh2-081: 1056 - round(1056 x
  0.24) = 803, not 1056 - round(263 x f) = 802). Flexible keeps "discount the full period, then
  prorate the discount" (wide-002 needs it). This is the order difference of MOD-01.
- A charge discount whose prorated amount is 0 is not "applied": no "(with ...)" and not listed
  (wide-117, one second left).
- Discount list of proration lines in an immediate flexible invoice: the credit lists the
  invoice's discounts, the charge lists its own (wide-117, wide-025, d-pct20-always).

Predicted: the 9 flip, nothing else moves. Actual (local replay): 361 of 361 logic fixtures, 8 of
8 lifecycle.

## Pass 3: the Customer Portal (UI-01..14)

Read from the ui-, uf- and x- fixtures:

- Configuration and session API; the session URL points at the clone (`/p/session/test_...`).
- The page fires, per step, exactly the recorded calls: home = session (first load only), then
  customer, subscriptions and payment_methods issued together; "Update subscription" = GET
  subscription; Continue = GET subscription, customer, update_preview; "Cancel subscription" =
  GET subscription and its retention_coupon; confirming = POST the subscription with
  `recurring_items[0][id|price|quantity]`; cancelling = POST .../cancel with `refund=false`;
  renewing = POST .../reactivate without a body; "Go back" to the home switches at once and
  refreshes in the background (ui-cancel-go-back captures all three GETs).
- The portal cancel sets `cancel_at` to the period end and leaves `cancel_at_period_end` false
  (uf-cancel account state). A portal plan change creates the proration invoice items with the
  flexible rules at the clock time (pending_items).
- Home: discounted recurring price; "Your next estimated payment" only with pending prorations or a
  discount; its details start open when the invoice has a discount (UI-05), and show the credit
  balance when the total is negative. Quantity worlds show "Name(×q)" and a price breakdown;
  "View details" does nothing on a home whose subscription is set to cancel (x-quantity 9 -> 9).
- "Go back" on "Add payment method" stays on that screen (x-basic 3 -> 3).
- Plan list: quantity worlds show a stepper instead of "Selected"; the quantity carries over
  when another plan is selected.

Layout: boxes are keyed by element tag and `innerText` (so `text-transform: uppercase` shows),
which fixes which elements may own text. Two recorded artefacts are reproduced, not reasoned
about:

- (Removed in pass 4.) The intro's layout key used to be cut at "...for sim" and the clone
  reproduced it with a `::after` pseudo-element. The uf-* walkthroughs were re-captured with
  whole keys, so the intro span now holds the whole sentence. The account name keeps the
  captured width (259 px).
- Fonts: Liberation Sans, sizes tuned so that every box of the eight uf- fixtures lands within the
  policy's 16 px.

Contradiction, not fixable: the card expiry is the recording's wall-clock month plus one year.
ui-* fixtures (recorded 2026-09-23) show "Expires 09/2027"; uf-* and x-* (2026-10-01) show
"10/2027". x-basic and ui-cancel-go-back set up identical worlds and differ only there, so no
deterministic function of the inputs satisfies both. The clone writes 10/2027 (the later
recordings, 11 fixtures) and loses ui-upgrade, ui-downgrade, ui-coupon-upgrade,
ui-cancel-renew and ui-cancel-go-back on that single line. Likewise the "Cancels Mar 3, 2027"
badge prints the year because 2027 is not the recording year; the clone keeps 2026 as the
current year.

Predicted: uf-* (8), x-* (3), ui-go-back and ui-reselect-current flip; the five ui-* above stay
failing on the expiry line only.

Actual: verify 382 of 387, as predicted. The five failures differ only on the "Expires 09/2027"
line. First attempt at the portal missed ui-cancel-go-back on its requests (home was rendered
only after sequential loads); fixed by switching screens at once and issuing the three GETs
together. Determinism: 10 of 10 sampled fixtures identical after reset.

Not covered by any dev fixture (unverified): LIF-03 (end of a subscription set to cancel at
period end) and LIF-04 (reactivate before the end) are implemented from their statements only.

## Pass 4: corrected rules after holdout batch 1 (DSC-01, DSC-05, DSC-07, DSC-08, INT-02, INV-01)

Baseline (local replay of the 667 logic/lifecycle dev cases): 611 pass, 56 fail: dev-t2-a* (8),
-b* (10), -c* (7), -d* (12), -e* (6), -f* (5), wide2-014/045/053 (credit list), wide2-061/069/290
(credit off by a cent), wide2-281 (allocation). The holdout analysis was read for the rule
statements only; no amount or case ID from it is used in code.

Rules as read from the dev cases:

- DSC-01: percent-off total = round(pct x S) over what is left of the discountable lines,
  spread floor(total x line / S), remainder one cent per line from the last line (same as
  amount-off). The first invoice uses it too, so a flexible credit moves with it. Expected to
  flip: dev-t2-a*, wide2-281, wide2-061/069/290.
- DSC-05: a once coupon passed to the preview is on the invoice (`discounts`,
  `total_discount_amounts`) when the change prorates nothing (it then discounts the renewal) and
  in an immediate invoice (at 0 there). Only a non-immediate invoice with prorations leaves it
  off. Expected: dev-t2-b-noop-* (4), dev-t2-b-always-* (6, with DSC-07).
- DSC-07 (flexible, immediate invoice), credit line list, as the dev cases pin it:
  invoice has no discount -> nothing; credit carried nothing -> the invoice's discounts;
  the carried discounts that survive DSC-08 are none -> nothing; exactly one -> that one (even
  when the invoice's discount is another coupon: dev-t2-c-forever-forever, -c-forever-once,
  -b-always-flexible-forever); two -> the invoice's discounts. The rules.json wording ("lists
  the invoice's discounts unless everything it carries is a used once coupon") disagrees with
  dev-t2-c-forever-forever and dev-t2-b-always-flexible-forever, where a single carried forever
  coupon is listed instead of the passed one. Implemented the fixture reading.
- DSC-08: flexible credit drops a carried discount whose prorated amount round(D r / P) is 0,
  from the description and the line's own list. Expected: dev-t2-d-flexible-* (12),
  dev-t2-e-m2y-flexible-pct-end1.
- INT-02: no "prd < period end" gate any more. A credit with r = 0 and a charge with r2 = 0 are
  omitted; a classic interval change bills a full new period for each changed item even without
  a credit line. Expected: dev-t2-e-*-end0 (6).
- INV-01: an invoice whose amount due is above 0 and below the minimum charge is marked paid,
  amount_due 0, and the amount goes to the customer balance; the next preview shows it as
  starting_balance and adds it to amount_due. Contradiction: rules.json says "below 50
  cents", but dev-t2-f-left50 and dev-t2-f-left51 (50 and 51 cents) are not charged either;
  fresh2-132 (291) is charged. The threshold is somewhere in 52..291. The account is French,
  so the minimum is probably 0.50 EUR converted; the clone uses 59 cents (an assumption, not
  pinned by any dev case). Expected: dev-t2-f-* (5).

Outcome (local replay, 678 logic and lifecycle cases): first attempt 677 of 678. Every predicted
case flipped; wide2-157 broke on DSC-07. It carries a once coupon that took the whole first
invoice and a 2 % forever coupon that got 0 there; Stripe lists the invoice's coupon, not the
once coupon. So "carried" counts every discount on the billed line, zero amounts included
(classic still prorates only the non-zero ones). Second attempt, the rule as implemented:

    immediate flexible credit list =
      []                     if the invoice has no discount
      invoice's discounts    if the billed line had no discount
      []                     if no carried discount survives DSC-08
      the surviving one      if the billed line had exactly one discount
      invoice's discounts    otherwise

678 of 678 after it. This table fits every dev case but reads like a lookup table more than a
mechanism; the holdout may hold combinations (two carried, one surviving) it does not cover.

uf-* re-captured with whole layout keys: the intro span now holds the whole sentence and the
`::after` trick is gone. 15 of 15 ui-/uf- pass locally.

x-quantity speed. Measured on the clone with a timed copy of the explorer loop: 18 states, 41
edges, 42 replays, 261 s; per replay about 5-7 s, the same as x-basic (17 replays, 92-102 s). The
quantity screens themselves settle like the others (one 500 ms network-idle wait after load,
three 500 ms polls per click). I could not reproduce 28 minutes here, but timings.jsonl shows
one earlier 2394 s verify. One real stall was found: the card form's iframe was created by
`innerHTML` when "Add payment method" opened, and after a cancel the page then never became
network-idle, so `settle` waited out its 5 s timeout twice (17 s for one replay instead of 7 s).
Fix: the frame is in the page from the start and only shown on that screen, so no frame
attaches after load. After the fix every settle on that path takes 0-1 ms, and x-quantity takes
250 s in the local replay. Nothing detects the explorer.

Result: `npm run verify stripe-billing` 696 of 696 dev fixtures pass (whole run 415 s). Every
rule with dev fixtures is verified; LIF-03 and LIF-04 still have none (unverified).

## Pass 5: breaker probes, wide3, dev-v2, minimum charge

Baseline: verify 939 of 976 dev. 37 failures, read one by one (the rule groups overlap; the
largest, PRO-01..05 / ITM-01 / INT-01, share the causes below):

1. Allocation (DSC-01/DSC-03; wide3-018, wide3-256 and the credits that inherit it). "Remainder
   one cent per line from the last line" is a special case of cumulative flooring: line i gets
   floor(T C_i / S) - floor(T C_(i-1) / S), C_i the running sum of the bases. wide3-256 (4
   lines, remainder 2) gives the 2nd and 4th lines a cent, which only the cumulative form
   explains; all 90 dev renewal allocations with a remainder agree with it (checked offline).
2. Once coupons (DSC-05; dev-brk-free-once, wide3-027, -054, -230, -249). A once coupon is spent
   only by an invoice where it took more than 0; one that got 0 (a 0 first invoice, or another
   coupon took everything) stays active. In a preview, an active once coupon (kept from the
   subscription or passed) that takes something from a remaining-time charge is spent there: not
   listed, not applied to the renewal. One that takes nothing from the prorations is listed and
   applies to the renewal lines (generalises DSC-05 a/b). Immediate invoices list it (c).
3. Zero-amount items (ITM-01/PRO-08; dev-brk-qty0-item, dev-brk-free-once): an old item billed at
   0 (amount 0 or quantity 0) gets no credit line.
4. Classic credit label (wide3-054, -249): counts every discount on the billed line, zero ones
   included ("with discounts"); the prorated amount still uses the non-zero ones.
5. Flexible charge discount rounding (PRO-04; dev-brk-off-huge/pct100/stack-full/pct20-half):
   the discount is prorated with the charge's float factor, Math.round(D (1 - e/P)); credits
   stay exact, half away from zero.
6. Classic charge at an exact half (dev-brk-big-half-charge-classic: 99999999/18 = 5555555.5 is
   charged 5555555, while 3000 x 0.0075 = 22.5 is charged 23): consistent with r/P truncated to a
   fixed number of decimals before multiplying, then half up. Any 4..15 decimals fit the dev
   cases; 12 is a guess.
7. Mixed intervals (INT-01/ITM-01; dev-brk-interval-multi-*, wide3-080/093/270/274): in flexible
   mode each item keeps its own period; a changed item's new period runs from the current
   period start for its new interval. The preview is the invoice at the earliest item period
   end and renews only the items whose period ends there. The proration date may equal the new
   end (dev-brk-y2m-at-new-end, -jan30-at-end) and is rejected only past it. Errors
   (wide3-086/105/146/155/168/223/225/238/290): classic with items of different intervals ->
   "All prices on a subscription must have the same `recurring.interval`..."; flexible with
   mixed intervals and a forever amount-off coupon in the new state -> "Subscriptions with
   multiple intervals only support percent_off coupons...".
8. INV-01: minimum charge 56 (dev-t2-f-left56..58, dev-brk-inv-56-pct95).
9. ERR-02: code resource_missing on 404s (dev-v2-missing-object).
10. LIF-06: dev-v2-retry-days pins the first retry within 2 days and the second between 3 days
    1 hour and 4 days 1 hour after the first failure; retries at +1 and +4 days.

Prediction: all 37 flip and nothing else moves (risk: point 2 changes when a passed once coupon
is listed in non-immediate previews; point 5 may move older flexible coupon cases).

Outcome: first attempt, verify 976 of 976 dev, as predicted; no earlier case moved.

Thin spots left after pass 5:

- Point 6 (classic truncation digits) is pinned by two cases only; the number of decimals is a
  guess within 4..15.
- Point 7: which coupons the mixed-interval error looks at when a coupon is passed to the
  preview (the clone checks the new state's discounts) and the order of the errors are not
  pinned. Classic previews never mix intervals (they error), so the clone's lifecycle code still
  assumes one interval per subscription.
- LIF-06: the retry days 1 and 4 are one choice among the schedules the two cases allow.
- Contradiction with rules.json, DSC-07 wording: still as in pass 4.

## Pass 6: classic credits and quantity 0 (DSC-04, PRO-11), the agent's API calls

Baseline: verify 994 of 1013 dev. Failing: 11 dev-b3-classic-_, 7 dev-ag-_, dev-v3-two-subscriptions.

### 6a. DSC-04 and PRO-11 (rule groups PRO-01/PRO-05/MOD-01, 11 fixtures)

- DSC-04 as now stated: the classic credit is -round_half_away(net x r / P), net = the old item's
  amount after every discount on its billed line, in subscription order, applied to that item alone
  (amount-off in full, percent-off round(pct x left), floor 0). The share each discount got on the
  billing invoice no longer matters, a share of 0 included. Pass 5 kept only the non-zero ones;
  that was an unforced choice the dev set could not refute (analysis of spent batch 3).
- PRO-11: classic, the changed item's new amount (unit x new quantity) is 0 -> no remaining-time
  line, under every behaviour; the renewal still lists the item at 0. Flexible keeps the 0 line.
  A once coupon passed to the preview then takes nothing from the prorations, so (pass 5 rule) it
  is listed and applies to the renewal (dev-b3-classic-b9-qty0-once-preview agrees: listed, 0).
- Expected to flip: the 11 dev-b3-classic-* (a1, a2, a4, a5-three-start, b6 x3, b7, b8, b9 x2).
  The flexible counterparts and b10 must not move.

### 6b. The agent's API calls (dev-ag-*, dev-v3-two-subscriptions)

Raw calls are compared whole (every field of the body), so the objects now carry Stripe's full
shapes as recorded: subscription (legacy `plan`/`quantity` for a single item, `null` otherwise;
`cancellation_details.reason` "cancellation_requested" after a cancel), subscription item (with
`plan`), price, customer (currency set by the first subscription), discount (expandable),
invoice item. `created` of prices is wall-clock on Stripe and recorded as noise; the clone uses
the latest clock time. The classic `billing_mode` shape is not recorded; it is a guess.

Rules read from the fixtures:

- POST /v1/subscriptions/:id with `items[i][id|price|quantity]` changes the item in place (same
  `si_` ID, quantity 1 when only the price is sent, PRO-10), at the clock time. Default and
  create_prorations: the credit and the charge become pending invoice items dated now (list order:
  newest date first, same date in creation order, credit then charge); none: no item.
  always_invoice (no dev case): the pending items are invoiced at once and paid.
- POST /v1/subscription_items/:id (price, quantity, proration_behavior): the same change; returns
  the item.
- `discounts[0][coupon]` replaces the subscription's discounts with a new one started now; the
  legacy `coupon` parameter is refused on a flexible subscription ("...not supported: coupon.",
  param null) and applied like `discounts` on a classic one (no dev case).
- create_preview with only `subscription`: the pending invoice items first (their `ii_` IDs), then
  the renewal; no `subscription_proration_date` unless a proration date was sent.
- GET /v1/invoices/upcoming: 400 "This API method has been deprecated...".
- GET /v1/subscriptions?customer=: newest first, canceled ones left out; GET /v1/prices/:id,
  GET /v1/customers/:id, GET /v1/subscription_items?subscription=.
- DELETE /v1/subscriptions/:id with invoice_now/prorate in the query: as LIF-05.

Expected to flip: the 7 dev-ag-* and dev-v3-two-subscriptions. dev-v3-past-due-recovers already
passes (retry at +1 day).

Outcome, pass 6: 6a as predicted (1005 of 1013, the 11 dev-b3-classic-* flipped, nothing else
moved). 6b: in a local replay the first attempt passed 8 of 9 agent cases; the last one,
dev-ag-coupon-discounts, failed because `expand[]=discounts` parses to a plain string, not a list.
After that fix, `npm run verify stripe-billing`: 1013 of 1013 dev.

Thin spots after pass 6 (no dev case pins them):

- always_invoice on a real update, an interval change made for real (cycle reset), the legacy
  `coupon` on a classic subscription, and the classic `billing_mode` object shape.
- A second change in the same period credits the item at its current price with the discounts of
  the invoice that last billed it; Stripe may credit the earlier proration instead.
- PRO-11 with a coupon on the subscription and a once coupon passed to the preview: pinned by the
  two dev-b3-classic-b9 cases only.
- Contradiction with rules.json, DSC-07 wording: still as in pass 4.
