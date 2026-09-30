# software-clone-factory

A factory for **verified clones of closed-source software**: resettable, deterministic copies of a
product's behaviour that agents can be trained and evaluated in, with the fidelity of every clone
**measured against the original** rather than asserted.

Agents build, code judges:

- **The truth is recorded.** Designed and random probes are sent to the real product (here, Stripe
  in test mode), each twice to detect noise; the answers are frozen as fixtures, hash-locked.
- **An agent builds the clone** from the development fixtures only, in a sandbox that never holds
  the holdout.
- **A script scores it.** It replays every fixture against a freshly reset clone and compares field
  by field. It reports the clean holdout apart from the rest, with a confidence bound.

The factory knows nothing about any product: a target plugs in through one adapter (its probes, a
way to run a probe on either side, a way to start its clone).

## First target: Stripe Billing

- **Slice 1:** a mid-cycle plan change (proration, rounding, coupons, billing modes), through the
  invoice preview API and the Customer Portal screens.
- **Slice 2:** cancel and renew in the portal, and the subscription lifecycle over test clocks.

The clone in this repository was built by the builder agent. Its measured fidelity, gaps and blind
spots are in [`targets/stripe-billing/GAPS.md`](targets/stripe-billing/GAPS.md). A rebuild from
scratch in an isolated container, against a larger pre-registered holdout, is in progress.

Not affiliated with Stripe. The clone reimplements observed behaviour of the public API in test
mode; it contains no Stripe code, and no documentation text beyond short quotes.

## Run it

Node 22 or later.

```bash
npm install && npx playwright install chromium
npm run verify stripe-billing -- --split all   # replay every recorded fixture against the clone
npm run demo                                   # start the clone and print a portal URL to open
```

`verify` needs no Stripe account: the fixtures are Stripe's recorded behaviour. Its exit code is 0
only when every fixture passes. To record new fixtures, copy `.env.example` to `.env` and set a
Stripe **test-mode** key; recording refuses any other kind of key.

| Command                                 | What it does                                                                  |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `npm run record stripe-billing`         | record the probes that have no fixture yet                                    |
| `npm run clone stripe-billing`          | serve the clone on `http://127.0.0.1:4599`; `POST /__reset` restores the seed |
| `npm run check`                         | types, lint, format, tests                                                    |
| `harness/run-builder.sh stripe-billing` | run the builder agent in a sandbox without the holdout                        |
| `npm run new-slice <name>`              | scaffold a new target                                                         |
| `git config core.hooksPath .githooks`   | pre-commit check (check plus evaluator lock)                                  |

## Layout

| Where                                                | What                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`docs/verification.md`](docs/verification.md)       | what "verified" means: the five rules, measurement, process                                        |
| [`docs/target-triage.md`](docs/target-triage.md)     | how a target is classified by recording mode before any work                                       |
| [`docs/lessons.md`](docs/lessons.md)                 | what went wrong so far, and the rule it gave                                                       |
| [`.claude/`](.claude/)                               | the method as a skill (`replicate-slice`), the agents (recorder, builder, breaker), the guard hook |
| [`harness/`](harness/)                               | recorder, verifier, evaluator lock, diff policy, clone kit, sandbox runners                        |
| [`targets/stripe-billing/`](targets/stripe-billing/) | recon, rule ledger, probes, recorded fixtures, the clone, gaps                                     |

## License

MIT.
