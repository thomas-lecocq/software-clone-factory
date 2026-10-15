# Gaps: stripe-billing

Owner: main session. The hand-written account of where the clone is wrong, might be wrong, or was
never compared. The generated list is `GAPS.generated.md`; scores are in `verify/` and every
claim's single look is in `measurements.md`.

## Scope

Stripe Billing in **test mode**, USD, through the public API and the hosted Customer Portal:

- **Slice 1:** the preview (`invoices.createPreview`) of a mid-cycle change on a subscription of 1
  to 3 items sharing a monthly or yearly interval: new price, new quantity or both, at any second
  of the first period, with 0 to 2 subscription coupons (percent or amount off, forever or once)
  and an optional preview coupon, in flexible or classic billing mode, under the three proration
  behaviours. The portal's plan change flow.
- **Slice 2:** cancel at period end, reactivate, cancel now, renewals and a failing card over test
  clocks; the portal's cancel and renew flow.

Two claims carry a pre-registered bound, both on slice 1 (`probes.ts`): on `WIDE_DISTRIBUTION`,
below 1 % of cases diverge at 99 % confidence (holdout batch 2, 473 of 473, clone v1); on
`WIDE_DISTRIBUTION_V2` (up to 4 items, amounts from 50 cents to $100,000, 100 % coupons, quantity
0), below 1 % at 99 % (batch 6, 473 of 473, clone v5, `fdbdd0e`), after two clones at 95 % only
(batch 4, 472 of 473, v3; batch 5, 472 of 473, v4). Everything else below is counts without a
claim.

**A quarter of that batch is easy.** Of its 473 cases, 74 are Stripe errors (70 of them the
`none` behaviour given a proration date) and 56 are changes that change nothing (50 with no change at all, 6 that
ask for the current quantity). On the 343 other cases, with no failure either, the bound is 0.87 % at 95 % and 1.33 % at 99 %: on substantive
changes alone the result is "below 1 % at 95 %", not at 99 %. This split was not in the plan, so it
is descriptive only; the pre-registered claim stands as stated.

## Measured divergences

None in batch 2's and batch 6's measurements (473 of 473 each). In batch 4's and batch 5's, one
each (`hold-b4-s1-089`, `hold-b5-s1-068`), within the plans' tolerance, plus the hash-split
holdout case `wide3-210`: all changes to one of several items under several discounts.
`analysis/hold-b4-failures.md` explains batch 4's (a discount whose prorated share rounds to 0 is
dropped from the credit line); the v5 probes fixed the area, and clone v5 passes all three, which
is no evidence since those sets were spent. Batch 3's seven failures (classic billing mode,
`analysis/hold-b3-failures.md`) were fixed through dev probes before batch 4. Measured earlier and fixed through new dev
probes, never by reading a holdout the clone was later scored on:

| When                        | Where                 | Behaviour                                                       | Fixed by                        |
| --------------------------- | --------------------- | --------------------------------------------------------------- | ------------------------------- |
| Batch 1 (448 of 473)        | 8 cases               | percent coupon over several lines: rounded on the total, spread | `dev-t2-a*`, DSC-01             |
| Batch 1                     | 7 cases               | once coupon passed to the preview: listed, at 0 when immediate  | `dev-t2-b*`, DSC-05             |
| Batch 1                     | 5 cases               | credit-line discount list in immediate flexible invoices        | `dev-t2-c*`, DSC-07             |
| Batch 1                     | 2 cases               | flexible credit whose discount prorates to 0                    | `dev-t2-d*`, DSC-08             |
| Batch 1                     | 2 cases               | interval change with the proration date at the period end       | `dev-t2-e*`, INT-02             |
| Batch 1                     | 1 case                | first invoice under the minimum charge goes to the balance      | `dev-t2-f*`, INV-01             |
| Dev, after the batch 2 look | `dev-t2-f-left56..58` | minimum charge is 56 cents; the measured clone uses 59          | not fixed in the measured clone |

The analysis of batch 1 is `analysis/batch1-failures.md`. The clone measured before that analysis
(`7238f46`) also fails 22 of batch 2's 473 cases: the second builder pass is what closed the gap.

## Measured on clone v5 after its claim (dev, outside the claim's distribution)

The `dev-v6-` probes, written for v5's mutation holes and its builder's unpinned choices and
recorded after batch 6's look, show 7 divergences of the claimed clone, all in the lifecycle API
rather than slice 1's preview:

- clearing `cancel_at` after a mid-period `cancel_at` with prorations (`dev-v6-cancel-at-mid-cleared`);
- `create_preview` given an invalid `proration_behavior`: Stripe rejects it, the clone answers
  (`dev-v6-invalid-proration-behavior`);
- finalizing a manual invoice (`dev-v6-invoice-routing`);
- creating a subscription for a customer with no payment method: Stripe refuses
  (`dev-v6-list-by-customer`);
- a one-off item attached to another subscription of the same customer, at renewal
  (`dev-v6-oneoff-other-subscription`);
- pending one-off items in an `always_invoice` change and in a preview: Stripe includes them
  (`dev-v6-pending-item-always-invoice`, `dev-v6-pending-item-preview`).

The 60 `dev-v6-classic-once-` cases (once coupons in classic mode on several items) all pass.
These are listed in `expected-failures.json` until a next clone is built and measured.

## Rules that fit the fixtures but are thin

- **DSC-07 (credit-line discounts in immediate flexible invoices).** Implemented as a decision
  table over the observed cases, not as a mechanism (`clone/NOTES.md`), corrected after the batch
  4 analysis and fitted again by the v5 builder. It holds on batch 6; an input outside the
  distribution may fall in a cell no fixture filled (the analysis puts the shape it explains at
  about 0.08 % of draws).
- **PRO-04 (rounding at exactly .5)** and **MOD-01 (classic vs flexible)**: few separating cases.
- **LIF-03 and LIF-04** have no dev fixture: coded from their statements only, unverified.

## Found by task validation

`harness/src/tasks.ts` gives an agent (Sonnet 5.5) eight everyday billing tasks, twice each, once
against the clone and once against Stripe test mode, through a proxy that logs every call. The
agent succeeds in 16 of 16 runs on Stripe. On the clone:

| Clone | Agent succeeds | What failed                                                                                                                                           |
| ----- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2    | 10 of 16       | the three tasks that change a subscription's items or discounts: `POST /v1/subscriptions/:id` with `items` or `discounts`, which no fixture exercised |
| v3    | 14 of 16       | `apply-coupon`: the coupon is attached, but not expanded when read with `expand: ["discounts.source.coupon"]`                                         |
| v4    | 16 of 16       | nothing; same outcome as on Stripe in all 16 pairs                                                                                                    |
| v5    | 16 of 16       | nothing                                                                                                                                               |

Each row's failures became dev probes for the next clone (`dev-ag-`, `dev-v3-`, `dev-v4-expand-`).
Eight tasks are a small sample of what an agent may call: 16 of 16 says these tasks work, not
that the clone covers the API.

## Holes found by mutation testing

`audit/mutate.ts` plants 40 one-line bugs in any clone file but its entry module and replays every
dev fixture the unchanged clone passes, screens included. On clone v5 (1196 fixtures), 34 of 40
were caught. One survivor changes nothing by construction (the ID minter, `state.ts:232`; IDs are
compared canonicalised). The other 5 are behaviour no fixture pins:

- listing subscriptions filtered by customer (`api.ts:484`; every probe has one customer) or by
  status (`api.ts:486`);
- an invalid `proration_behavior` value (`api.ts:321`);
- a one-off invoice item tied to another subscription of the same customer, at renewal
  (`life.ts:115`);
- the routing of an invoice read by id (`api.ts:644`).

Each run samples 40 sites of the current code, so runs are not comparable site by site. On clone
v4, 30 of 40 caught; its 6 holes included fractional coupon percentages, whose `dev-v5-percent-`
probes now kill that mutant (`billing.ts:30`), and three portal error status codes, which no
probe kind can reach yet (the portal's internal API is only driven through screens). On clone
v3, 30 of 40 (8 holes, five of them the target of `dev-v4-` probes); on clone v2 (logic files
only), 30 of 40.

## Not pinned, chosen by the builder

The v4 builder's four choices (`clone/NOTES.md`, pass 7) became `dev-v5-` probes; one was wrong
(Stripe does pull pending one-off items into the next renewal) and v5 follows the fixtures. The
v5 builder reports four more (pass 8): clearing `cancel_at` after a mid-period `cancel_at` with
prorations, whether `cancel_at_period_end` puts pending items on a last invoice, whether
`always_invoice` and `create_preview` take the customer's one-off items, and the once-coupon rule
in classic mode (it applied the flexible behaviour). Not covered by a fixture; unverified.

## Compared nowhere (outside the probe space)

Not covered by a fixture, unverified: taxes, currencies other than USD, more than three items,
mixed intervals in one subscription, metered and tiered prices, schedules, trials during a
change, `repeating` coupons, promotion codes, customer balance beyond the minimum-charge case,
3D Secure and payment failures other than `pm_card_chargeCustomerFail`, portal flows other than
plan change, quantity change and cancel/renew, the retention coupon, the cancellation reason
dialog, **live mode** (assumed equal to test mode).

## Blind spots by design

- **Lifecycle snapshots and the post-flow account state are projections** (`lifecycle.ts`,
  `ui.ts`): fields outside them are not compared. Previews are compared field by field.
- **Screens:** link targets are dropped (they carry session secrets); element boxes are compared
  within 16 px (one trial on 2026-10-01, not kept, rendered the same Stripe page up to 12 px
  apart between macOS and the Linux image; the other 4 px are margin, and a builder can tune to
  the tolerance); the thumbnail is reported, never scored; the test card's expiry text is masked
  (`policy.json`), since it depends on the recording day.
- **Time bombs.** The card expiry follows the real date; the portal prints a year on dates that
  are not in the current real year, so screens recorded in 2026 will differ from Stripe's in 2027.
  Fixtures are frozen, so the clone keeps passing: the divergence becomes invisible.
- **The hash-split holdout's inputs** are visible to the builder in `probes.ts` (outputs are not).
  Pre-registered batches have hidden seeds.

## Evaluator integrity

- **One builder run per clone version.** The claim is about this clone, not about the factory's
  ability to build such clones every time; see `variance.md` for further builds.
- **The hash-split holdout is not clean:** looked at under several clone versions, and it holds
  cases designed after earlier failures. It is reported with that status and carries no claim.
- **Both batch runs were logged `dirty: true`** because the dirty-tree check excluded nothing (a
  pathspec bug, fixed in `1c64c83`); the scored code is the stated commit (`measurements.md`).
- **No ablation of the factory's components.** Record-first, the sandbox, the holdout batches
  and the guard were never switched off one at a time, so none of them can be credited with the
  result on its own. The one ablation run is of the second builder pass (`measurements.md`).
- **Guardrails are string matching**, but no longer the network's only defence: the agent
  container is on an internal network whose only way out is an egress proxy that lets through the
  model API (and hosts a target lists) and refuses the rest. The task-validation agent (whose
  target calls go through a logging proxy) and the auditors still run with an open network.
- **Auditors** found 12 of 12 planted defects (`audit/results/`); the defects and the auditor
  prompt share one author, and precision was adjudicated by that same author.
- **Account fragment in history.** Recorded object IDs carried an account-specific fragment;
  it is scrubbed from the current tree (`a783617`) but kept in earlier commits, since rewriting
  history would change the hashes that `measurements.md` cites as pre-registration evidence. It
  is not a secret.
- **Account constants** (country `FR`, name pseudonymised to "AcmeCo") are seed data.
