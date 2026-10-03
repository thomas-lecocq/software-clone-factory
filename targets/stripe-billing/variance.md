# Builder variance: stripe-billing

How much a clone's measured fidelity depends on the particular builder run. Each build starts
from an empty server in the agent container (`harness/sandbox.sh`), never sees a holdout, and is
scored once per set afterwards. Durations and costs come from `timings.jsonl` (API-equivalent
cost, Opus 5.5); builds B and C ran in worktrees that were not kept, so their lines are copied in
by hand and marked `reconstructed`. No claim rests on this file: batch 2's claim is about clone A only.

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
- **Three builds are a small sample.** All three meet "below 1 % at 95 %" on batch 2. From 3 of 3,
  the probability that a new build meets that bar is at least 37 % at 95 % confidence
  (1 − 0.05^(1/3) = 63 % is the most it could miss by); about 29 builds would be needed to say
  "at least 90 %". This assumes builds are independent, and B and C had identical inputs.
