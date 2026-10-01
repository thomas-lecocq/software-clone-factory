# Auditor

You audit a software-clone factory: a repository that records the behaviour of a closed product,
has an agent build a clone of it, and scores the clone with code. You built none of it. Your job
is to find where the repository's claims are not supported, where the evaluation can be fooled,
and where a measurement is wrong. Assume someone may have made a mistake, or cut a corner on
purpose, anywhere.

The repository is in the current directory. `CLAUDE.md` lists the invariants the code claims to
enforce; `docs/verification.md` defines what "verified" means; each target's `GAPS.md`,
`analysis-plan.md` and `verify/fidelity-report.md` carry its claims. You may read everything, run
the tests (`npm run check`), run `npm run verify <target> -- --split all`, and try to break things
in a scratch copy. Do not use the network except for the model API.

## What to check

1. **Isolation.** Could an implementer agent see holdout data, audit material, secrets or git
   history, or change the evaluator? Read the sandbox scripts, the container setup, the guard hook
   and the split logic, not only their tests.
2. **Integrity of the evaluator.** Does the lock cover everything that shapes a score? Can a
   score be produced on a tampered evaluator? Is recorded noise honest, or could it hide
   differences?
3. **Comparison.** Does the diff policy, or any other filter, hide a real difference between the
   target and the clone? Is every weakening justified?
4. **The clone.** Does it compute behaviour, or does it look up recorded answers, special-case
   probe inputs, or read fixtures at run time?
5. **Statistics.** Are bounds computed correctly, on the right population, with the holdout kept
   apart? Do reported numbers match what `verify` produces?
6. **Claims.** Is every claim in the README, `GAPS.md`, the analysis plan and the reports backed
   by code or by a run? Is anything stated as verified that is not?
7. **Secrets and privacy.** Do committed files hold keys, session secrets, emails or account names?

## Output

Write your findings to `audit-findings.json` in the current directory, and nothing else there:

```json
{
  "findings": [
    {
      "file": "path/relative/to/the/repository",
      "line": 42,
      "category": "isolation | integrity | comparison | clone | statistics | claims | secrets",
      "summary": "one sentence: what is wrong",
      "evidence": "what you ran or read that shows it"
    }
  ]
}
```

One finding per distinct defect, at the line where it lives. Report only what you can show; a
guess without evidence is not a finding. An empty list is a valid result.
