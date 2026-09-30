# Clone notes: stripe-billing

## Summary (main session)

The builder's logbook across three passes; the summary below is by the main session, the rest is
the builder's own record.

- **Proration:** each line is the prorated amount minus the prorated full-period discount; a price
  change without a quantity bills quantity 1 (PRO-10, not in the original ledger).
- **Discounts by mode:** flexible mode discounts inside proration lines; classic mode takes the
  coupon off before prorating on the credit and after on the charge, which moves some lines by one
  cent (DSC-02, DSC-04, MOD-01).
- **Interval changes:** flexible mode prorates and keeps the anchor, classic mode resets the cycle;
  a proration date past the new period is rejected (INT-01).
- **Contradictions found:** the recon note "credits are never discounted", the documented anchor
  reset on interval changes, and `proration_behavior=none` with a date (rejected, not honoured).
- **Portal:** requests are fired in a fixed order per step; the details toggle starts open only when
  the invoice carries a discount.
- **Open:** amount-off allocation across several lines never observed; the classic percent charge
  rests on one fixture; rounding exactly at .5 on six lines.

Rules as read from the dev fixtures. Only `targets/stripe-billing/clone/` is written by the
builder. Values below are learnt from fixtures and written in code; nothing is read at runtime.

## Pass 1: the API (d-* and rand-* fixtures)

Iteration 1 targets every PRO-_, PER-01, DSC-_, MOD-01 and ERR-01 fixture in one go, because they
share one invoice builder. Expected to flip: the 59 d-* and rand-* dev fixtures.

### Period (PER-01)

- A monthly period runs to the same day, hour, minute and second of the next calendar month
  (`odd` start 17 Dec 12:34:56 ends 17 Jan 12:34:56; the Feb start has a 28-day period). The day is
  clamped to the month's length (not covered by any dev fixture).
- `P = period_end - period_start`, `R = period_end - proration_date`, `f = R / P`.

### Proration lines (PRO-01..04, PRO-08, DSC-02..04)

Tested against all 108 proration lines in dev: 108 of 108 match.

- `b0 = old unit amount x old quantity`, `b1 = new unit amount x new quantity`.
- **Quantity reset:** when the price changes and no quantity is sent, the new quantity is **1**,
  not the old quantity (rand-004, rand-011: q=2 or 4 before, the charge and the next line are q=1).
- `D(b, coupon)` = the full-period discount on `b`: `round(b x pct / 100)` for percent,
  `min(amount_off, b)` for amount.
- credit = `-(round(b0 f) - round(D(b0, O) f))`, `O` = the discount in force on the credited period.
- charge = `round(b1 f) - round(D(b1, N) f)`, `N` = the discount in force after the change.
- Rounding cannot be told apart between half-up and half-even (no dev line lands on .5).
  `Math.round` is used.
- `O` is the subscription's discount, including a `once` coupon (it applied to the first
  invoice). `N` is the preview's `discounts` if given, else the subscription's discount unless its
  coupon is `once`.
- Proration lines are never `discountable`; `discount_amounts` lists the discounts with amount 0:
  credit lists `O` then `N` (deduplicated), charge lists `N`. `pretax_credit_amounts` mirrors
  `discount_amounts` with `type: "discount"`.
- Descriptions: `Unused time on [q × ]Basic[ (with X off)] after DD Mon YYYY` and
  `Remaining time on [q × ]Pro[ (with X off)] after DD Mon YYYY`, date in UTC; `X` is `20.0%` or
  `$3.00`. The quantity prefix appears only when q > 1.
- No price change and no quantity change: no proration lines (d-same-price), but
  `subscription_proration_date` is still reported.

### Invoice shape (PRO-05, PRO-07, PRO-09, DSC-01, DSC-05)

- Default (`create_prorations`): prorations, then the next period at the new price
  (`N × Pro (at $30.00 / month)`, discountable, `unit_amount_decimal` = unit amount as a string),
  invoice-level discount `D(b1, N)` in its `discount_amounts` and `total_discount_amounts`.
  `created = period_end`, `next_payment_attempt = created + 3600`, `auto_advance = true`.
- `always_invoice`: only the proration lines; `created = period_start = period_end = clock time`,
  `next_payment_attempt = null`, `auto_advance = false`; `total_discount_amounts` still lists `N`
  with amount 0.
- `once` coupon: invoice `discounts` is `[]` and the next line is undiscounted (DSC-05).
- `total = subtotal - discounts`; `amount_due = amount_remaining = max(total, 0)`;
  `ending_balance = min(total, 0)` (PRO-09).
- **MOD-01:** amounts are identical in classic and flexible mode in every dev fixture. The single
  difference found: with a spent `once` coupon, the flexible credit line lists that discount in
  `discount_amounts` (amount 0), the classic one does not (rand-039 against d-off500-once-sub,
  rand-012, rand-037). The amount is discounted in both.

Result of iteration 1 (local replay): 58 of 59, as predicted except rand-039, fixed by the
classic/flexible difference above.

### Errors (ERR-01)

- `proration_date` outside `[period_start, period_end]`: `invalid_request_error`, param
  `proration_date`, message "Cannot specify proration date outside of current subscription period
  or current phase. The value should be between <start> and <end>."
- `proration_behavior=none` with a `proration_date`: "Cannot specify proration date if no proration
  is being done". This is what d-behavior-none and d-pct20-none record, so PRO-06's "shows only the
  next period" is never observed in dev: the adapter always sends a proration date.

### Unverified guesses (no dev fixture)

- Interval change (INT-01): billing cycle reset to the proration date. **Superseded in pass 3:**
  the t-month-to-year-\* and b-year-to-month fixtures show the anchor is kept.
- Preview discounts and subscription discount together: the preview's replace the subscription's
  (confirmed in pass 3 by b-off300-sub-pct15-preview and t-two-coupons-\*).

## Pass 2: the Customer Portal (ui-* fixtures)

Iteration 1 targets UI-01..06 together (one page, one flow). Expected to flip: the 5 ui-* fixtures.

- The session `url` is `http://<Host header>/p/session/<token>`: it points at the clone. The page
  is a small vanilla-JS single-page app; everything it shows comes from the portal JSON endpoints
  under `/v1/billing_portal/sessions/<bps>/...`, whose order per step is checked (UI-04):
  - load: `GET <bps>`, `GET customer`, `GET subscriptions`, `GET payment_methods`;
  - "Update subscription" and "Go back": `GET subscriptions/<sub>`;
  - "Continue": `GET subscriptions/<sub>`, `GET customer`, `GET update_preview`;
  - "Subscribe and pay": `POST subscriptions/<sub>`, then `GET customer`, `GET subscriptions`,
    `GET payment_methods` (no session GET);
  - "Select" makes no request.
    The requests are sequential so their order is deterministic.
- Home (UI-01): "Current subscription <Plan> <amount after discount> per month Your next billing
  date is <Month D, YYYY>." then, only when the upcoming invoice is more than the plain recurring
  line (prorations pending or a discount), "Your next estimated payment will be <amount_due>" with a
  details toggle. **The toggle starts open ("Hide details") when the invoice carries a discount and
  closed ("View details") otherwise** (ui-coupon-upgrade against ui-upgrade). Details: lines
  grouped by period ("Nov 5-Dec 5, 2026"), labelled "Prorated credit from X", "Prorated charge for
  Y" or the plan name, then Subtotal, "20% off -$6.00", Total.
- The portal update happens at the clock's time, which is the period start in every walkthrough,
  so the credit covers the whole period: upgrade $50.00 = -10 + 30 + 30; downgrade -30 + 10 + 10 =
  -10, shown as amount due $0.00; with 20 % off, -8 + 24 + 30 - 6 = $40.00.
- Plan list (UI-02): products in configuration order, "Current subscription" before the current
  plan, the selected plan shows "Selected" instead of a "Select" button, "Subtotal <price> per
  month" of the selection (undiscounted), "Continue" disabled while the selection is current.
- Confirm (UI-03): "Confirm Confirm your updates <Plan> What you'll pay monthly starting <date>",
  then the recurring amount after discount; with a discount a "View details" button sits before the
  amount. An aria-hidden info icon after the amount shows the tooltip on hover.
- "Go back" (UI-06) reloads the plan list with the current plan selected.

### Constants

- Account `FR` / "environnement de test AcmeCo", `issuer.type = self`.
- `pm_card_visa`: Visa 4242, expires 09/2027. In the real product the expiry follows the real date;
  it is a constant here so the clone stays deterministic.

## Outcome

`npm run verify stripe-billing`: 64 of 64 dev fixtures pass. The two passes matched their
predictions; the only miss was rand-039 on the first API iteration (see MOD-01). No fixture is
special-cased and no behaviour needed a lookup table.

Fixtures that contradict or sharpen `rules.json` / RECON.md:

- RECON.md says the unused-time credit is not discounted. In every dev fixture with a coupon on
  the subscription it is (d-pct20-downgrade, d-off300-forever-sub, ...); only a coupon given to the
  preview leaves it undiscounted (d-pct15-preview).
- PRO-01/PRO-02 omit the quantity reset: a new price without a quantity bills quantity 1.
- DSC-02 ("discount inside proration lines in flexible mode") holds in classic mode too; DSC-04's
  "classic uses the discounted price" is true of both modes. The amounts never differ between
  modes in dev (MOD-01 is verified only through the `discount_amounts` difference).
- PRO-06 is never observed as stated: with a proration date, `proration_behavior=none` is an
  error (d-behavior-none, d-pct20-none), which is what the PRO-06 fixtures record.
- UI-05: the details panel starts open when the invoice has a discount, closed otherwise; the rule
  does not say so.

`npm run check`: tsc, eslint, vitest and Prettier on the clone are clean. `prettier --check .`
flags `GAPS.generated.md`, `verify/report.md` and `verify/verdict.json`, which `npm run verify`
writes unformatted; the builder may not touch them.

## Pass 3 (2026-09-23): new t-_, b-_ and fresh-* fixtures (PRO, PER, INT, DSC groups)

Starting point: `npm run verify stripe-billing` 113 of 135 dev. The PRO-01..05 group has the most
failing fixtures (12). Rules as read from them:

- **Rounding at .5 (PRO-04).** Half-up on the magnitude, except the flexible-mode charge line.
  t-round-half-2.5 (credit 2.5 -> -3, charge 7.5 -> 7), t-round-half-7.5 (7.5 -> -8, 22.5 -> 22),
  b-round-half (500.5 -> -501, 1501.5 -> 1502), t-round-half-classic (7.5 -> -8, 22.5 -> 23).
  No integer rule (half-even, half-down, toward zero) fits all six. What fits is a float
  artefact: the flexible charge is `round(b1 x (1 - elapsed / P))` in binary floating point, which
  gives 7.4999..., 22.4999... but exactly 1501.5 when `elapsed / P = 0.5`. The credit is
  `round(b0 x remaining / P)`. Classic uses `remaining / P` for both. A hypothesis that fits the
  six observed lines, not a documented rule.
- **Classic with a percent coupon (DSC-04, t-disc-round-classic-36):** classic prorates the
  already discounted period amount: `round((b - D(b)) x f)` (-3804), while flexible subtracts two
  rounded terms `round(b f) - round(D f)` (-3805, t-disc-round-flex-36). Both agree on the -17 pair.
- **Proration date at the period end (b-up-at-period-end):** no proration lines at all.
- **Anchor clamping (PER-01, b-clamp-jan31):** periods are computed from the billing cycle anchor,
  not chained: Jan 31 -> Feb 28 -> Mar 31.
- **Interval change (INT-01, t-month-to-year-\*, b-year-to-month): the anchor is NOT reset.**
  The new item's period runs from the current period start to start + new interval; the charge
  is prorated over that new period (`(newEnd - prd) / (newEnd - start)`), the credit over the old
  one. The preview is still the renewal at `newEnd` (`created = period_end = newEnd`), with the
  next full period `newEnd -> newEnd + interval`. This contradicts INT-01 as written.
- **Preview coupon replacing a subscription coupon (b-off300-sub-pct15-preview,
  t-two-coupons-\*):** the credit line's `discount_amounts` lists only the discounts of the preview
  (the replacing ones); the credited period's discount is listed only when the preview has none
  of its own (flexible, spent `once` coupon: rand-039).

Expected to flip: the 12 PRO-group fixtures listed in failures.json (b-clamp-jan31,
b-off300-sub-pct15-preview, b-up-at-period-end, b-year-to-month, t-disc-round-classic-36,
t-month-to-year-{25d,2d,coupon}, t-round-half-{2.5,7.5}, t-two-coupons-{off-pct,pct-off}).

## Pass 4 (2026-09-23): slice 2, lifecycle (l-*, LIF-01..07)

Rules as read from the eight l-* fixtures (default billing mode, flexible):

- **Renewal (LIF-01, l-renews, l-renews-twice):** at the period end a `subscription_cycle` invoice
  is created (lines: pending items, then the full next period), `period_start/period_end` of the
  invoice = the period just ended; it is finalised and paid one hour later (`created + 3600`,
  which is where the probes' `31 days + 3600 s` advances land). The period moves by one calendar
  month from the anchor.
- **Cancel at period end (LIF-02):** `cancel_at = period_end`, `canceled_at = now` at the request.
  A later cancel-now keeps that `canceled_at` and clears `cancel_at` and `cancel_at_period_end`
  (l-cancel-at-end-then-now). LIF-03 and LIF-04 have no dev fixture: crossing the end with
  cancel_at_period_end cancels with `ended_at = cancel_at` and no invoice (documented, unverified).
- **Cancel now (LIF-05):** `status = canceled`, `ended_at = now`, `canceled_at = now` unless already
  set; the item period is unchanged. `prorate` adds an "Unused time on <plan> after <date>" credit
  (credit rounding); `invoice_now` bills the pending items at once in a **draft**
  `subscription_cycle` invoice whose period is `period_start -> now`; without `invoice_now` no
  invoice is created (count stays 1).
- **Failed payment (LIF-06, l-payment-fails-retries):** the renewal invoice stays `open`, the
  subscription becomes `past_due`, the period still moves. 3 attempts 5 days after the first.
  **The retry schedule is a guess from that single point:** a retry every 2 days (first + 2 d,
  - 4 d). Any schedule with 2 retries in (0, 5 d) fits.
- **Trial (LIF-07, l-trial):** `trialing`, `trial_end = start + days`, period `start -> trial_end`,
  a paid zero invoice "Free trial for 1 × Basic" with `attempt_count 0`. At the trial end the
  anchor moves to `trial_end` and a paid `subscription_cycle` invoice for `trial_end -> +1 month`
  is created, with invoice period `start -> trial_end`.

Expected to flip: the 8 l-* fixtures.

## Pass 5 (2026-09-23): slice 2, portal cancel (ui-cancel-*, UI-07..10)

- Home: with `subscription_cancel` enabled in the configuration, a "Cancel subscription" link
  follows "Update subscription". When cancelling at period end, the home reads "Current
  subscription Cancels <Mon D> <plan> <amount> per month Your service will end on <date>.", no
  estimated payment, and the link becomes "Don't cancel subscription".
- "Cancel subscription" link: `GET subscriptions/<sub>`, `GET subscriptions/<sub>/retention_coupon`,
  then the review screen ("Billing" crumb only, "Cancel Review your changes <plan> <amount> per
  month If you cancel ... on <date>.", button "Cancel subscription" with two icons, "Go back").
- Confirm: `POST subscriptions/<sub>/cancel`, then the home reload (customer, subscriptions,
  payment_methods). "Go back": the same home reload.
- "Don't cancel subscription": `GET subscriptions/<sub>`, renew screen ("Renew Renew your
  subscription Current subscription <plan> <amount> per month This subscription will no longer be
  canceled. It will renew on <date>.", button "Renew subscription", "Go back"); "Renew
  subscription": `POST .../reactivate`, then the home reload.

Expected to flip: ui-cancel-go-back, ui-cancel-renew.

## Outcome of passes 3 to 5 (2026-09-23)

- **First slice 2 pass: 2026-09-23T17:07:10Z** (timestamp of that `npm run verify` run in
  `failures.jsonl`). That run gave 125 of 135 dev: all eight l-\* fixtures and ui-cancel-renew
  passed for the first time.
- The same run showed two prediction misses, both mine:
  - 8 regressions (d-off500-once-sub, fresh-002/019/020/022, rand-012/037/039): the new invoice
    store took the discounts still in force, so the first invoice lost its `once` coupon. The
    first invoice now keeps the coupon it was created with.
  - fresh-016 (classic, amount-off coupon): the pass 3 rule "classic prorates the discounted
    amount" is true only for percent coupons. An amount-off coupon is prorated as its own term
    (`round(b f) - round(off f)` = 637, not `round((b - off) f)` = 636). Rule corrected in code.
  - ui-cancel-go-back: the review screen itself contains "Cancel subscription", so the capture
    fired before the home reloaded. The page now clears the screen when a reload starts.
- Next run, at 17:07Z: **135 of 135 dev fixtures pass.**

Fixtures that contradict `rules.json`:

- **INT-01** says an interval change resets the billing cycle anchor. All four INT-01 fixtures
  show it is kept: the new item runs from the current period start to start + new interval, and
  the preview is the renewal at that date.
- **PRO-04** asks for one rounding rule. None fits: credits round half away from zero, the classic
  charge rounds half up, and the flexible charge rounds 7.5 and 22.5 down but 1501.5 up. The clone
  models this as floating point `1 - elapsed / P` (pass 3). It fits the six .5 lines in dev, but it
  is a hypothesis.
- **DSC-04/MOD-01**: amounts do differ between the modes. Classic applies a percent coupon to the
  period amount before prorating, so it is one cent off flexible in t-disc-round-classic-36 against
  -flex-36.
- **LIF-06**: "retries follow the account's retry schedule". Only one point is observed (3 attempts
  5 days after the first); the clone's 2-day spacing is a guess, not something learnt.
- **LIF-05**: the final invoice from `invoice_now` is a _draft_ `subscription_cycle` invoice, and a
  cancel-now after cancel_at_period_end keeps the earlier `canceled_at`. Neither is in the rule.
- LIF-03, LIF-04 and UI-07 have no dev fixture (0 of 0 in the report). They are implemented from
  their statements and are unverified.

## Pass 6 (2026-09-23): the u-\* and fresh2-\* dev cases (PRO, DSC, MOD, INT groups)

Starting point: `npm run verify stripe-billing` 258 of 267 dev. Nine dev cases fail; PRO-01..05
fail on all nine, so that group comes first. The nine have two causes:

- **Classic-mode discount rounding (6 cases: fresh2-002/081/124/140, u-classic-off-forever-q1,
  u-classic-off-once-q4).** Pass 5 said "classic prorates an amount-off coupon as its own term",
  from fresh-016. That is true of the **charge** line only. Rule as read now, `f = R / P`:
  - classic **credit**: `round((b - D(b)) f)` for percent **and** amount-off coupons (fresh2-002:
    31778 f = 18645.02 -> 18645; the two-term form gives 18644. u-classic-off-once-q4: 13579 where
    flexible gives 13580 on the same inputs);
  - classic **charge**: `g = round(b f)`, then subtract `round(off f)` for an amount-off coupon
    (fresh-016: 779 - 142 = 637) and `round(g x pct)` for a percent coupon, so the percent applies
    to the already prorated line (fresh2-081: 1056 - round(253.44) = 803, where `round(D f)` and
    `round((b - D) f)` both give 802);
  - flexible: unchanged (`round(b f) - round(D f)` on both lines).
- **Yearly to monthly (3 cases, INT-01):**
  - flexible, proration date after the end of the new (shorter) period counted from the current
    period start: error "You cannot specify `proration_date` past the updated subscription period
    end when using flexible billing mode. The value should be less than <newEnd>.", param null
    (u-year-to-month-60d, -200d). Before that date the anchor-kept rule of pass 3 holds (5d, 29d).
  - classic, interval change: the billing cycle **is** reset, to the clock time. The preview is an
    immediate invoice (`created = period_start = period_end = now`, `next_payment_attempt` null,
    `auto_advance` false) holding the credit over the old period, then a full period of the new
    price from `now` to `now + interval`. No charge line (u-year-to-month-classic-60d).
  - yearly to yearly keeps the period (u-year-to-year already passes).

Expected to flip: all nine. Risk: the classic charge rule may move the classic percent cases that
pass today with `round((b - D) f)` on the charge (t-disc-round-classic-36,
b-classic-pct20-downgrade).

Outcome: the next `npm run verify stripe-billing` gave **267 of 267 dev**. All nine flipped as
predicted and nothing regressed, so the classic percent cases that passed before also fit the new
charge rule. `npm run check` is clean.

What contradicts or sharpens the rule statements:

- **INT-01** says yearly to monthly "is not pinned by any dev fixture". It now is, and it depends on
  the mode: flexible keeps the anchor and rejects a proration date past the shorter new period's
  end; classic resets the cycle to the clock time and bills an immediate invoice with no charge
  line. The documented anchor reset holds in classic mode only.
- **DSC-04** ("in classic mode proration lines are not discountable; amounts match flexible") and
  **MOD-01** ("classic applies a percent coupon before prorating"): classic prorates the net
  amount on the credit for every coupon type, and on the charge it prorates the gross amount, then
  subtracts the coupon. So an amount-off coupon also moves the classic credit by a cent
  (u-classic-off-once-q4: -13579 in classic, -13580 in flexible).
- **DSC-03** (an amount-off coupon is spread in proportion across lines): every dev case still has
  one discountable line, so the proportional split itself stays unobserved.
- The classic charge rule (percent on the prorated line) is supported by one percent case where
  it is decisive (fresh2-081). The other forms are off by one cent there, so it fits the data but is
  thinly pinned.
