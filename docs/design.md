# Design

Why the factory is built the way it is. The rules themselves are in `verification.md`; this file
gives the reasons, and the alternatives that were rejected.

## Record first, then build

A clone is only as good as its specification, and for a closed product the only complete
specification is the product itself. So the factory records first: probes are sent to the real
target, twice each to detect noise, and the answers are frozen as fixtures. The builder agent
then works from those fixtures, not from documentation. Documentation is used to design probes
(where are the edges?), never as the oracle: where it and the product disagree, the product wins.

Rejected: building from documentation and testing afterwards. It produces a clone of the
documentation, and its errors surface only where someone thought to test.

## Agents build, code judges

Every score comes from a script that replays fixtures against a freshly reset clone and compares
field by field. No agent ever decides whether a case passes. An agent that grades its own work, or
another agent's, converges on what persuades the grader, which is not the same as what is right.

The evaluator is hash-locked (fixtures, diff policy, driver code, harness) and the lock must equal
the committed one, so a score always names the exact evaluator that produced it.

## Isolation is structural, guardrails are secondary

The builder runs in a container that mounts a copy of the repository without the holdout, the
audit material, any secret or the git history. What the builder cannot see it cannot overfit. A
hook that blocks reads and writes by pattern remains as a guardrail and as a log of attempts, but
string matching is not a boundary: an agent with a shell can always phrase a command differently.

## Measure like an experiment

A clone's fidelity is a claim about a distribution of inputs, so it is measured like one:

- **A holdout the builder never saw.** Dev fixtures are for building; only holdout cases count.
- **Sized from the claim.** With no failure in n cases, the one-sided 95 % upper bound on the
  failure rate is 1 − 0.05^(1/n). "Below 1 %" needs 299 cases; 29 cases only support "below 10 %".
- **Pre-registered.** The batch's distribution, size and decision rule are committed before it is
  recorded, and it is scored once. A holdout that has driven a decision is spent.
- **Every look logged.** `verify/runs.jsonl` records each run with its commit and lock, so the
  number of looks at a holdout is a fact rather than a recollection.

## Screens are behaviour too

An agent trained in a clone acts through its screens, so a wrong screen teaches a wrong habit.
Screens are checked in layers, from the cheapest and most decisive to the noisiest:

1. the accessibility tree of each screen, the calls it fires with their bodies, and the account
   state the flow leaves behind;
2. a breadth-first exploration that clicks everything reachable, so that untested paths (a button
   nobody scripted) are compared too;
3. element boxes within a stated tolerance, since fonts move the same page by a few pixels between
   platforms;
4. pixels, as a masked thumbnail, reported but never scored: an exact pixel match would reward
   copying assets and punish harmless rendering differences.

## Auditors are measured, not trusted

An audit that finds nothing proves nothing until the auditor's recall is known. The factory plants
known defects in a copy of the repository, runs the committed auditor prompt on it and counts what
was found. The defect library never enters a copy an auditor or a builder sees.

## What a clone is worth

The fidelity report puts the same nine sections in front of every clone: scope, clean
measurement, bound, coverage, determinism, divergences, saturation, task validation and integrity.
A section that does not apply says so, rather than disappearing.

## Related work

[REA](https://github.com/morluto/rea) gives an agent reverse-engineering tools for local
artefacts and websites, and returns evidence with its limits; the agent then writes its own
reconstruction. The aims differ: REA helps understand a program from the inside, down to its
binary; this factory builds a clone of a product's behaviour from the outside and measures it
against the original, with a holdout the builder never sees. The two compose: REA could serve
recon, and a clone of a local program could be measured here.
