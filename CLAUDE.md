# software-clone-factory

A target-agnostic factory that takes a closed-source product from "unknown" to "verified clone",
one slice at a time. Method: `.claude/skills/replicate-slice/SKILL.md`. Standard:
`docs/verification.md`.

Tooling: Node LTS, npm, TypeScript strict + `noUncheckedIndexedAccess`, ESLint `strictTypeChecked`,
Prettier, Vitest, zod at every boundary, Playwright. `npm run check` clean before every commit.

## Invariants (enforced in code, checked by tests)

1. Fixtures are written only by `npm run record`, from the real target. `fixtures.lock` hashes
   every fixture, the diff policy, the target's driver code, the harness and the manifests;
   `verify` aborts on any mismatch, and when the lock differs from the committed one.
2. Only `npm run verify` writes `verify/*` and `GAPS.generated.md`, and every run is appended to
   `verify/runs.jsonl`. Rule status is never stored in `rules.json`; it is computed.
3. Implementer agents run in the agent container (`harness/sandbox.sh`, image
   `harness/docker/Dockerfile`), which mounts only a sandbox copy with no holdout (hash-split, or
   a `hold-` batch with its seed), no audit material, no env or scrub files and no git history;
   only the requested folder (the clone) is copied back. Inside it, `harness/hooks/guard-oracle.sh` is a guardrail that blocks evaluator
   writes and holdout or audit reads, and logs blocked attempts.
4. Recording refuses any Stripe key that is not a test key.
5. Clone state lives in memory only. `POST /__reset` restores the seed; the same probe run twice
   after reset gives identical output.
6. Clone code never reads `fixtures/` at runtime.
7. `harness/` and `.claude/` never name a target.
8. Committed fixtures contain no secret (API keys, session secrets, auth headers, emails).

Language: English for every file in the repository.

## Ask the maintainer first

- A new dependency.
- Re-recording an existing fixture, or editing `docs/verification.md` or `docs/target-triage.md`.
- Any call to a target outside its test mode.

Free without asking: test-mode calls, subagents one at a time, everything else. After a deliberate
evaluator change: `npm run relock <t> -- --reason ...`, then commit.
