---
name: replicate-slice
description: Take one slice of a closed-source product from "unknown" to "verified clone" with this repository's harness. Use when starting a new target or a new slice of an existing target, or when resuming one.
---

# Replicate a slice

The method is target-agnostic. Everything about a target lives in `targets/<t>/`; if a step makes
you edit `harness/` or `.claude/` for one target, stop: that is a harness change, made on its own
and justified in its commit.

Read first: `docs/verification.md` (the standard), `docs/target-triage.md`, `docs/lessons.md`.

The session that follows this skill is the orchestrator. It runs the steps in order, delegates the
roles below, and stops at the human checkpoints. The method automates most of the work; a full
run on a new target with no other intervention has not been demonstrated yet.

## Roles

Permissions are enforced by structure wherever a role can run in a copy; prose and the guard hook
only add a guardrail. The table says which.

| Role         | Who                                        | Enforced by                                                   |
| ------------ | ------------------------------------------ | ------------------------------------------------------------- |
| Builder      | `builder` agent                            | container on a copy without holdout; only `clone/` comes back |
| Breaker      | `breaker` agent                            | container on a copy; nothing comes back                       |
| Analyst      | `analyst` agent                            | copy with one spent batch only; only `analysis/` comes back   |
| Auditor      | `audit/auditor.md`, run by `audit/meta.ts` | container on a planted copy; only its findings are read       |
| Scorer       | `npm run verify` (code, never an agent)    | deterministic code; the clone runs in a separate process      |
| Recorder     | `recorder` agent, and `npm run record`     | prose and the guard (it needs the target's key, so no copy)   |
| Orchestrator | the session following this skill           | prose and the human checkpoints below                         |

## Human checkpoints

Ask, then wait, before: choosing the target and the slice; the terms-of-service check (automated
access, replication clauses); creating accounts and keys; any spending beyond the stated budget
(builds, audits); recording in mode d (a human performs the actions); re-recording an existing
fixture; editing `docs/verification.md` or `docs/target-triage.md`; publishing anything.

## Steps

0. **Triage.** Classify the recording mode (`docs/target-triage.md`): it sets the cost and the
   fidelity that can be promised. `npm run new-slice <t>` scaffolds a new target.
1. **Recon.** Use the product once with capture on; for an API, script a minimal world. Write
   `targets/<t>/RECON.md`: where computed values appear, noise, error messages, surprises.
2. **Ledger** (recorder). `rules.json`: rules with provenance `observed | documented | inferred |
mined` and a reference. Documentation seeds rules; only a fixture confirms them. No status.
3. **Probe design** (recorder, then breaker in spec mode). In `probes.ts`:
   - designed probes: per rule, a case that triggers it and a boundary case; interacting rules
     combined; each probe creates its own starting state;
   - **the distribution D** the claim will speak about, as a seeded generator with its support
     written down in plain words (dimensions, ranges, frequencies), and dev probes drawn from it;
   - for screens: walkthroughs with full capture and breadth-first explorations;
   - then the breaker reads RECON, rules and documentation (no clone yet) and proposes inputs
     the generators never draw; widen D's support with what it finds before going on.
4. **Adapter.** `adapter.ts` implements `TargetAdapter`: `probes()`, `run(probe, side)` with the
   same code on both sides, `cloneEntry` (the clone's module; the harness runs it in its own
   process) and `recordedWith()` (the target's API and SDK versions).
5. **Policy**, before any clone code. `policy.json`: generated IDs canonicalised; every weakening
   (ignore, type, tolerance, perceptual, mask) carries its reason, decided from the target's own
   noise and semantics, never to make a clone pass.
6. **Record dev** (`npm run record <t>`): every probe twice, noise kept, scrubbed, locked. Commit
   fixtures and lock alone.
7. **Pre-register a holdout batch.** Size it from the claim: with no failure, 299 cases bound the
   failure rate below 1 % at 95 %; 473 still do so with one failure, and bound it below 1 % at
   99 % with none. Write `analysis-plan*.md` (batch IDs `hold-<name>-001…`, D, size, decision
   rule), draw the seed into `holdout-seed.json`, **commit both**, then record the batch.
   Prefer a **staged** batch (`stages` in `holdout-seed.json`, IDs `hold-<name>-s1-001…`): the plan
   then names each stage and the number of failures the claim tolerates.
8. **Build** (`harness/run-builder.sh <t>`). The builder works in the agent container on a copy
   with no holdout, no seed and no git history; only `clone/` comes back.
9. **Break** (`harness/run-agent.sh breaker <t> …`). The breaker reads the clone and proposes
   inputs to make it fail. Store them as `dev-brk-` probes (adversarial, never holdout), record,
   verify, and go back to 8 until a round finds nothing or the budget is spent. Their failure
   share is reported, never used as an estimate.
10. **Measure once.** Freeze the clone in a commit, run `npm run verify <t> -- --split holdout`
    once, apply the plan's decision rule and write the entry in `measurements.md`.
    For a staged batch: `npm run verify <t> -- --sequential hold-<name> --max-failures <k>` scores
    stage by stage and stops as soon as failures exceed k. Stopping only on failure leaves the
    success criterion unchanged, and the stages never scored stay fresh for the next clone.
11. **If the claim is rejected,** the batch is spent. Run `harness/run-analyst.sh <t> <batch>`
    right after the look; turn its findings into rules and `dev-` probes (designed after seeing
    failures, so they never certify); one more build pass; then a **new batch with a new seed
    and a new plan**, and back to 10. Never fix the failures and rescore the same batch.
12. **Variance**, when the budget allows: more builds from an empty server, each in its own
    worktree, each scored once on the claim's batch; write `variance.md`. Three builds show
    reproducibility; about 29 are needed to bound how often a build misses the bar below 10 %.
13. **Audit.** `npx tsx audit/meta.ts`: planted defects, recall per run; adjudicate the other
    findings and fix the real ones.
14. **Report.** `GAPS.md` with `## Scope` and `## Measured divergences` (the fidelity report quotes
    them), the claim with its scope in the README, and a test from a fresh clone (`npm ci`,
    `npm run check`, `verify --split all`).
15. **Lessons.** Append to `docs/lessons.md` what cost time and the rule that would have saved it.

## Rules that hold across steps

- **Learn only from spent sets.** Rules, probes and prompts may change after a batch's look;
  every new claim then needs a fresh batch. Every look is logged and counted per set.
- **Prefixes decide the split:** `hold-` is always holdout, `dev-` always dev, anything else by
  hash (a quarter to holdout, which carries no claim once looked at under several clone versions).
- **Costs are logged** in `timings.jsonl` (recording, verify, every agent run); quote them.

## Re-recording

Only with evidence that the target changed or the recording was wrong (replaying the original
shows it), never because the clone fails:
`npm run record <t> -- --rerecord <id> --reason "<evidence>"`, in its own commit whose message
carries the reason and the old and new hashes the command prints.

## Claims

Fidelity is stated as "N of M" with its bound, the set's status and the distribution it holds for.
Anything without a fixture is written: "Not covered by a fixture; behaviour inferred from
<source>; unverified."
