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

The one claim with a pre-registered bound is on slice 1's `WIDE_DISTRIBUTION` (`probes.ts`):
below 1 % of cases diverge, at 99 % confidence (holdout batch 2, 473 of 473). Everything else
below is counts without a claim.

**A quarter of that batch is easy.** Of its 473 cases, 74 are Stripe errors (70 of them the
`none` behaviour given a proration date) and 56 are changes that change nothing (50 with no change at all, 6 that
ask for the current quantity). On the 343 other cases, with no failure either, the bound is 0.87 % at 95 % and 1.33 % at 99 %: on substantive
changes alone the result is "below 1 % at 95 %", not at 99 %. This split was not in the plan, so it
is descriptive only; the pre-registered claim stands as stated.

## Measured divergences

None in the claim's measurement (batch 2, 473 of 473). Measured earlier and fixed through new dev
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

## Rules that fit the fixtures but are thin

- **DSC-07 (credit-line discounts in immediate flexible invoices).** Implemented as a decision
  table over the observed cases, not as a mechanism (`clone/NOTES.md`). It holds on batch 2; an
  input outside the distribution may fall in a cell no fixture filled.
- **PRO-04 (rounding at exactly .5)** and **MOD-01 (classic vs flexible)**: few separating cases.
- **LIF-03 and LIF-04** have no dev fixture: coded from their statements only, unverified.

## Found by task validation

`harness/src/tasks.ts` gave an agent (Sonnet 5.5) eight everyday billing tasks, twice each, once
against the clone and once against Stripe test mode, through a proxy that logs every call. The
agent succeeds in 16 of 16 runs on Stripe and 10 of 16 on the clone. The six failures are the three
tasks that change a subscription's items or discounts (moving to another price, up or down, and
adding a coupon): the agent calls `POST /v1/subscriptions/:id` with `items` or `discounts`, or
`POST /v1/subscription_items/:id`, which no fixture ever exercised and the clone does not
implement. High fidelity on the measured slice says nothing about the calls an agent will make;
the traces in `tasks/` are the design of the next dev probes.

## Holes found by mutation testing

`audit/mutate.ts` planted 40 one-line bugs in the clone's logic and replayed the 715 dev logic
fixtures the unchanged clone passes: 30 were caught. Of the 10 that survived, 4 change nothing by
construction (a loop's safety bound, two constants of the ID minter, whose IDs are compared
canonicalised, and distributing a zero remainder). The other 6 are behaviour no fixture pins:

- the error returned for an object that does not exist (`api.ts:44`);
- which of two events at the same instant comes first (`life.ts:206`);
- a once-only coupon over the subscription lifecycle (`life.ts:83`);
- listing invoice items when several customers exist; every probe has one (`api.ts:307`);
- the delay before the first payment retry; only the second is pinned (`life.ts:31`);
- a routing condition for invoice items (`api.ts:431`).

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
- **Guardrails are string matching.** The guard hook blocks by pattern and can be phrased around;
  isolation rests on the container and the sandbox copy. The container has network access (no
  Stripe key inside); code hosts are refused by the guard, not by the network.
- **Auditors** found 12 of 12 planted defects (`audit/results/`); the defects and the auditor
  prompt share one author, and precision was adjudicated by that same author.
- **Account fragment in history.** Recorded object IDs carried an account-specific fragment;
  it is scrubbed from the current tree (`a783617`) but kept in earlier commits, since rewriting
  history would change the hashes that `measurements.md` cites as pre-registration evidence. It
  is not a secret.
- **Account constants** (country `FR`, name pseudonymised to "AcmeCo") are seed data.
