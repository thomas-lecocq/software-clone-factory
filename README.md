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

## How a clone is checked

| Layer       | What is compared                                                                     | Decides the verdict |
| ----------- | ------------------------------------------------------------------------------------ | ------------------- |
| API         | every field of every response, generated IDs compared by the references between them | yes                 |
| Screens     | the accessibility tree of each screen a scripted walkthrough reaches                 | yes                 |
| Calls       | the body and status of each call a screen fires                                      | yes                 |
| Effect      | the account state a UI flow leaves behind, read through the public API               | yes                 |
| State graph | every screen reachable by clicking, breadth first, and every transition between them | yes                 |
| Layout      | the box of each visible element, within a tolerance the diff policy states           | yes                 |
| Pixels      | a masked grey thumbnail                                                              | reported only       |

Each run writes a **fidelity report** (`verify/fidelity-report.md`): scope, clean measurement,
confidence bound, coverage, determinism, divergences, saturation, task validation, integrity. The
headline number comes from a holdout batch whose size, distribution and decision rule were
committed before it was recorded (`analysis-plan.md`), and which is scored once.

The auditors are measured too: `audit/meta.ts` plants known defects in a copy of the repository,
runs the committed auditor prompt on it, and reports the share it found. The defect library stays
out of every copy an auditor or a builder sees.

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

| Command                                 | What it does                                                                                                   |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run record stripe-billing`         | record the probes that have no fixture yet                                                                     |
| `npm run clone stripe-billing`          | serve the clone on `http://127.0.0.1:4599`; `POST /__reset` restores the seed                                  |
| `npm run check`                         | types, lint, format, tests                                                                                     |
| `harness/run-builder.sh stripe-billing` | run the builder agent in the agent container, on a sandbox without the holdout (needs Docker and `.agent.env`) |
| `npm run new-slice <name>`              | scaffold a new target                                                                                          |
| `git config core.hooksPath .githooks`   | pre-commit check (check plus evaluator lock)                                                                   |

## Layout

| Where                                                | What                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| [`docs/verification.md`](docs/verification.md)       | what "verified" means: the five rules, measurement, process                                        |
| [`docs/design.md`](docs/design.md)                   | why the factory is built this way, and what was rejected                                           |
| [`docs/target-triage.md`](docs/target-triage.md)     | how a target is classified by recording mode before any work                                       |
| [`docs/lessons.md`](docs/lessons.md)                 | what went wrong so far, and the rule it gave                                                       |
| [`audit/`](audit/)                                   | the auditor prompt, the planted-defect library and the script that measures auditors               |
| [`.claude/`](.claude/)                               | the method as a skill (`replicate-slice`), the agents (recorder, builder, breaker), the guard hook |
| [`harness/`](harness/)                               | recorder, verifier, evaluator lock, diff policy, clone kit, sandbox runners                        |
| [`targets/stripe-billing/`](targets/stripe-billing/) | recon, rule ledger, probes, recorded fixtures, the clone, gaps                                     |

## License

MIT.
