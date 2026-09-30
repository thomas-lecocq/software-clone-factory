# Recon: Stripe Billing (test mode)

Owner: main session. Step 1 of the replication playbook. Run on 2026-09-23 with
`recon/recon.sh` (raw responses in `recon/out/`, not committed: they carry account IDs).

## What was done

On a test clock frozen at `1790000000` (2026-09-21T14:13:20Z): one product with two monthly
prices (10 USD, 30 USD), a 20 % forever coupon, one customer with `pm_card_visa`, one subscription
on the 10 USD price. Then `POST /v1/invoices/create_preview` for an upgrade to 30 USD at
`proration_date = T0 + 10 days`, with and without the coupon, each run twice. Then a Customer
Portal configuration and two portal sessions (home, and the `subscription_update_confirm` deep link).

## Observed

- **Preview is deterministic except for IDs.** Diffing the two runs field by field, only `id`,
  `lines.data[].id`, `lines.data[].invoice`, `...invoice_item` and `lines.url` differ. Noise mask
  candidates: every `*_id`-like path with prefixes `upcoming_in_`, `il_tmp_`, `ii_`, `di_`.
- **Proration arithmetic, 20 of 30 days remaining:**
  - credit for unused time on the old price: `-667` (1000 × 20/30 = 666.67, rounded to 667);
  - charge for remaining time on the new price: `2000`;
  - next full period on the new price: `3000`;
  - `subtotal = total = amount_due = 4333`.
- **Coupon interaction (20 % off), a quirk worth a rule:** the remaining-time line is discounted
  inside the line (`1600`, description "avec 20.0% off"), the unused-time credit is not discounted
  (`-667`), and the next-period line is discounted at invoice level (`total_discount_amounts = 600`).
  Result: `subtotal 3933`, `total 3333`.
- **Billing mode:** new subscriptions default to `billing_mode.type = flexible` with
  `proration_discounts = included`. The docs describe `classic` as giving different totals for the
  same sequence: a parameter of the slice, not a constant.
- **Line descriptions follow the account or customer locale** (French here). Either set
  `preferred_locales` on the customer or mask descriptions: a noise source unrelated to logic.
- **Portal configuration rules, found by error messages** (awkward cases a faithful clone must reproduce):
  - "For each product, its price must have unique billing intervals" → the plan switch needs one
    product per plan.
  - "Cannot enable subscription updates while payment method update is disabled."
- **Portal sessions** (home and update-confirm deep link) are created by API; URLs point to
  `billing.stripe.com`.

## Portal (recorded with `recon/portal.ts`, Playwright headless)

- **The confirmation screen does not show the proration.** It shows the new plan, "What you'll pay
  monthly starting October 21, 2026 $30.00", the card, and a "Subscribe and pay" button. The info
  icon's tooltip says: "This estimate covers recurring charges. One-time adjustments, like
  prorations and credits, will appear on your final invoice." An awkward behaviour to reproduce
  as is.
- **The proration is in the traffic, not on screen.** The page calls
  `GET billing.stripe.com/v1/billing_portal/sessions/<bps>/update_preview`, which returns
  `latest_invoice`, `upcoming_invoice`, `recurring_invoice`, `generates_immediate_invoice`,
  `reset_billing_cycle_anchor`, `schedule_update_at_period_end`. At clock time T0 (whole period
  unused) `upcoming_invoice` = `-1000 + 3000 + 3000 = 5000`, `generates_immediate_invoice = false`:
  the proration is billed at the next renewal, not now.
- The portal page calls `api.hcaptcha.com/checksiteconfig`; no challenge was shown in test mode.
- The aria snapshot contains the session secret in a link URL: scrubbing must cover snapshots,
  not only HAR headers (R-27).
- Chrome headless opened in `en-US` still shows the account name in French: account-level
  strings are data, not locale.

## Still open

1. Dashboard- and portal-specific terms (only the Services Agreement was read).
2. Rounding rule: one case (666.67 → 667) is consistent with half-up and with half-even. A probe
   landing exactly on .5 is needed.
3. Portal screens before and after confirmation (plan list, success state) not yet captured.
