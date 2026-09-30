---
name: replicate-slice
description: Take one slice of a closed-source product from "unknown" to "verified clone" with this repository's harness. Use when starting a new target or a new slice of an existing target, or when resuming one.
---

# Replicate a slice

The method is target-agnostic. Everything about a target lives in `targets/<t>/`; if a step makes
you edit `harness/` or `.claude/` for one target, stop: that is a harness change, made on its own
and justified in its commit.

Read first: `docs/verification.md` (the standard), `docs/target-triage.md`, `docs/lessons.md`.

0. **Triage** (main session). Classify the target's recording mode (`docs/target-triage.md`), which
   sets the cost and the fidelity that can be promised. `npm run new-slice <t>` scaffolds a new
   target.

## Steps

1. **Recon** (main session). Use the product once with capture on; for an API, script a minimal
   world. Write `targets/<t>/RECON.md`: where computed values appear, noise seen, error messages,
   anything surprising. Check the terms for automated access and replication clauses.
2. **Ledger** (recorder). `targets/<t>/rules.json`: 8 to 20 rules, each with provenance
   `observed | documented | inferred | mined` and a reference. Documentation seeds rules; it never
   confirms them. No status field: status is computed.
3. **Probes** (recorder). `targets/<t>/probes.ts`: per rule, a case that triggers it and a boundary
   or non-trigger case; interacting rules combined; a seeded random batch with its distribution
   written down. Each probe is self-contained (it creates its own starting state).
4. **Adapter** (main session). `targets/<t>/adapter.ts` implements `TargetAdapter`: `probes()`,
   `run(probe, side)` with the same code for target and clone, `startClone(port)`.
5. **Policy** (main session, before any clone code). `targets/<t>/policy.json`: generated IDs are
   canonicalised; any ignored field has a one-line reason. Decided from the target's own noise
   and semantics, never to make the clone pass.
6. **Record** (`npm run record <t>`). Runs every probe twice on the target, stores the noise,
   scrubs, splits dev/holdout, writes `fixtures.lock`. Commit fixtures and lock alone.
7. **Build** (builder agent, `.claude/agents/builder.md`). Implements `targets/<t>/clone/` from
   the rules and dev fixtures, one rule group at a time, running `npm run verify <t>` after each.
8. **Break** (breaker agent). Looks for behaviour the fixtures do not pin; proposes new probes in
   `targets/<t>/probes.proposed.md`. The recorder adds the good ones; go back to 6.
9. **Measure** (main session). Commit `targets/<t>/analysis-plan.md` (distribution, holdout size,
   threshold, stopping rule) before recording the holdout batch; then `npm run verify <t> -- --split
all` once. The report, `GAPS.generated.md` and a hand-written `GAPS.md` are the result.
10. **Lessons**. Append to `docs/lessons.md` what cost time and the rule of thumb that would have
    saved it.

## Re-recording

Only with evidence that the target changed or the recording was wrong (replaying the original
shows it), never because the clone fails:
`npm run record <t> -- --rerecord <id> --reason "<evidence>"`, in its own commit whose message
carries the reason and the old and new hashes the command prints.

## Claims

Fidelity is stated only as "N of M fixtures pass" with the report. Anything without a fixture is
written: "Not covered by a fixture; behaviour inferred from <source>; unverified."
