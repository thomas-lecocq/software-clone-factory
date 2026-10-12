# Roadmap

What the factory could do next, after the first public version. Nothing here is built yet; each
item says why it matters and roughly what it costs.

## Make the factory run end to end

- **Demonstrate the orchestration end to end.** The skill now describes the whole workflow as it
  ran, with its human checkpoints, and a session following it is the orchestrator. "Automated
  with human checkpoints" becomes a claim only after a fresh session, given the skill and a new
  target, produces a measured clone with no other intervention.
- **A probe designer agent** with a breaker phase on the specification (documentation, recon),
  before any clone exists: it widens the distribution's support (dimensions, ranges) so that the
  first build already faces what a later breaker round would find. Reads `docs/lessons.md` and
  per-domain playbooks.
- **Learning across builds and targets.** Today learning lives in the data (fixtures, rules,
  analyses, lessons). Builder and designer prompts, and per-domain playbooks (billing, booking…),
  could learn from spent batches too; every claim then still needs a fresh batch.
- **Breaker rounds until saturation**: repeat until a round finds nothing, and report the rounds.

## Measure better

- **Distribution v2** for slice 1, widened by breaker round 1 (more than three items, quantity
  0, 100 % coupons, very large amounts, mixed intervals), with a new pre-registered batch.
- **A distribution from real usage** (anonymised logs, frequencies) rather than one we drew, so
  that "below 1 %" speaks about the cases that occur.
- **More builds for variance.** Three builds show reproducibility; bounding how often a build
  misses the bar below 10 % needs about 29 builds (about $600 at today's cost).
- **Ablations of the factory's components** (record-first, the sandbox, holdout batches, the
  guard) and a **documentation-first baseline**, so that a component can be credited.
- **Task validation without training.** Give an existing agent scripted tasks ("change this
  customer's plan with a 20 % coupon"), run it against the clone and against the target's test
  mode, and compare success and the actions taken: does an agent behave the same in the clone?
- **Live mode check** on a small, cheap sample, since test mode is assumed equal to live.
- **The two last layers of screen verification.** Layer 4: an LLM triages the flagged pixel and
  layout differences (never scores them); layer 5: a human reviews a sample to calibrate the
  tolerances and the triage. Only layers 1 to 3 exist today.
- **Account fingerprint in IDs.** Recorded object IDs carry an account-specific fragment. Not a
  secret, but the scrubber could replace it to make fixtures fully anonymous.
- **Ensembles.** The three clones fail different cases; a majority vote passes all 473 of batch 2.
  Worth testing as a way to buy reliability with compute.

## Ideas from REA (Reverse Engineer Anything)

[REA](https://github.com/morluto/rea) gives agents white-box reverse-engineering tools and keeps
claims tied to evidence. Several of its contracts would strengthen this factory:

- **Required case kinds per rule.** REA's reconstruction obligations demand positive, negative,
  malformed and cancellation cases before a claim can close; our rules ask for a triggering and
  a boundary case. Adding a malformed-input or error case per rule makes coverage systematic.
- **Authority.** A claim closes only with a verifier of comparable authority to the original
  observation (a static fact never proves runtime behaviour). The factory follows this
  implicitly, since only recorded runtime output counts; `verification.md` should say so.
- **Contradictions kept, not masked.** Two different outputs for the same input (the test card's
  expiry) would be recorded as a contradiction that blocks the affected comparison, where we
  masked the text. A contradiction record would keep the evidence visible.
- **Partial-order comparison** for concurrent behaviour. Portal calls are compared in total
  order; a target with parallel requests would show false divergences.
- **Mutation testing of the verifier.** Plant deliberate bugs in a copy of the clone and check
  that `verify` catches each one, as the auditors are measured on planted defects today.
- **REA as a recon tool.** Its browser and JavaScript analysis could map a hosted UI's bundle
  (routes, calls) during recon, and it covers recording mode a (local software) directly.

## Spend fewer holdout cases

A batch that drove a decision is spent, and recording a new one costs time (1.5 hours here,
much more where a human records). Three ways to spend less:

1. **Pre-registered sequential testing.** Split a batch into sub-batches (for example 3 × 158),
   use a fresh one per iteration, with a stopping rule and thresholds corrected for repeated
   looks (alpha spending).
2. **Aggregate-only feedback.** Tell the builder side only "rejected", never which cases failed;
   it leaks less, though a look is still adaptive.
3. **A reusable holdout** (Thresholdout, Dwork et al., 2015): noisy answers that allow reuse with
   a bounded loss of validity.

## Harden the evaluator

- **A network allowlist for the agent container** (a proxy that lets through the model API and
  documentation only); the guard's code-host block is string matching today.
- **Independent authors.** Probes, planted defects and the auditor prompt share one author; a
  second author, or defects mined from real escapes, would test the auditors on blind spots.
- **Timestamped pre-registration.** Commit order proves the plan came first only as far as the
  author is trusted; pushing each plan before recording, or timestamping it (OpenTimestamps),
  makes the order checkable by others.

## Grow the scope

- Fix the clone's known divergences (12 breaker probes, the 56-cent minimum charge) in a new
  version, measured on a new batch.
- A third slice of Stripe Billing, then a second target with another recording mode.
- The write-up on GitHub Pages.
