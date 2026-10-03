# Lessons

One line per lesson, read at step 1 of the `replicate-slice` skill: where, symptom, rule of thumb.

## Targets

- **stripe-billing, recon.** The portal configuration rejected two prices on one product ("unique
  billing intervals") and plan switching without payment-method updates. Probe the setup API's
  error messages first: they are cheap, awkward-case rules.
- **stripe-billing, recon.** Line descriptions followed the account locale. Pin every locale knob in
  the probe setup before recording.
- **stripe-billing, recon.** The portal screen hides the logic of the slice (prorations appear only
  in the page's JSON). Capture traffic with every UI recording; the screen can under-show the logic.
- **stripe-billing, probes.** A rule with a single fixture can land entirely in the holdout, and
  the builder then has to guess it. Give every rule at least two probes before splitting.

## Harness

- **Hooks and sessions.** A project hook does not fire for subagents of a session started outside
  the repository. Run implementer agents from the repository root (headless), and live-test the
  guard with a throwaway agent before relying on it.
- **Formatting.** A formatter rewrote a hash-locked file. Exclude locked files from every formatter.
- **Isolation.** A hook that matches strings was bypassed 27 times out of 31 by an auditor with a
  shell. Isolate implementers structurally (a sandbox without the holdout or git history) and tie
  the lock to the committed version; keep the hook as a guardrail.
- **Reports.** A verify report that listed holdout cases by ID leaked the holdout. Anything an
  implementer can read carries dev details and holdout totals only.
- **Sandboxes.** A copied sandbox kept a symlink back into the repository and carried the env file.
  Copy, never link; exclude env files by pattern; check the sandbox before starting the agent;
  delete it afterwards.
- **Checks.** An integrity check that passes when its input is missing is not a check. Fail closed,
  with an explicit, logged flag for the one context allowed to skip it.
- **Hooks fail open by default.** A guard that could not write its log exited with code 1, which
  Claude Code treats as "allow": every block was silently lifted in a fresh repository. A blocking
  hook must exit 2 on any error, and be live-tested in the environment the agent actually runs in.
- **Pre-registration.** A first measurement on a fresh, pre-registered batch rejected the claim
  (448 of 473). Plan for a second batch from the start: fixing the failures and rescoring the same
  batch would have shown 100 % by construction.
- **Easy cases.** A quarter of a generated batch was trivial (errors, changes that change
  nothing). Report the substantive share apart, and design generators that rarely draw it.
- **Layout keys.** Keys cut to a fixed length before scrubbing depended on the account name's
  length, and a builder fitted the artefact. Scrub before any truncation, or never truncate keys.
- **Policy modes.** A mask on every path was picked as the field's mode and silently turned
  tolerances into exact comparisons. A rewriting rule must never choose how a field is compared.
- **Pathspecs.** `:!dir` in `git status` excluded nothing, so every run was logged dirty. Use
  `:(exclude,glob)dir/**`, and test the dirty check against a tree with only outputs changed.
- **In-process clones.** A clone imported by the verifier can patch the verifier's globals. Run
  it in a child process and talk HTTP.
- **Host sleep.** A laptop on battery slept through a two-hour build and the agent's request
  died. Keep the host awake and on power (`caffeinate` is not enough on battery), and copy the
  work back even when a run fails.
- **Recording-day text.** A test card's expiry follows the recording month, so fixtures recorded
  on different days disagreed for identical inputs. Mask such text in the policy, with its reason.
- **Fresh copies.** A lock that hashed macOS hidden files broke `verify` on every fresh checkout.
  Run the deliverable from a fresh clone before calling it done.
