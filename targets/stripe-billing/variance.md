# Builder variance: stripe-billing

How much a clone's measured fidelity depends on the particular builder run. Each build starts
from an empty server in the agent container (`harness/sandbox.sh`), never sees a holdout, and is
scored once per set afterwards. Durations and costs come from `timings.jsonl` (API-equivalent
cost, Opus 5.5). No claim rests on this file: batch 2's claim is about clone A only.

| Build | Inputs                                                 | Time and cost         | Dev       | Batch 2   | Batch 1 (spent) |
| ----- | ------------------------------------------------------ | --------------------- | --------- | --------- | --------------- |
| A     | 387 dev fixtures, then a pass with batch 1's analysis  | 60 + 32 min, $16 + $7 | 696 / 696 | 473 / 473 | 448 / 473 ¹     |
| B     | everything at `6858756`: 708 dev, the batch 1 analysis | 82 min, $23           | 708 / 708 | 472 / 473 | 473 / 473       |
| C     | the same as B                                          | 104 min, $23          | 708 / 708 | 472 / 473 | 473 / 473       |

¹ Before its second pass; that look is batch 1's single measurement (`measurements.md`).

- **Spread.** On batch 2, the three clones fail 0, 1 and 1 case of 473, never the same one
  (B: `hold-b2-155`, C: `hold-b2-438`). Pooled, 2 failures in 1419 case runs. Taken alone, B and C
  would each support "below 1 % at 95 %" (bound 0.999 %) but not at 99 % (1.40 %), so clone A's
  99 % result is the best of what a build gives here, not what every build gives.
- **Comparability.** B and C had more to learn from than A's first build: the 379 dev probes and
  the analysis that followed batch 1. They compare with A after its second pass.
- **A fourth build was interrupted** after 68 minutes ($8) when the host went to sleep; its
  partial clone passed 699 of 708 dev fixtures. It is not counted.
- **Three builds are a small sample.** They show that results vary by a case or so per 473 on
  this distribution; they do not estimate how often a build would do worse.
