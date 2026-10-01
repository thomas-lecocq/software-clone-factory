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

- The account name was replaced by a shorter literal when the fixtures were scrubbed, so the
  intro's key is cut at "...for sim". The intro span holds exactly that text and "plified
  billing." comes from a `::after` pseudo-element (in the accessibility tree, not in `innerText`).
  The account name keeps the recorded width (259 px) for the same reason.
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
