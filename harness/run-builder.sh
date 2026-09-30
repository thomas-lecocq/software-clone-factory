#!/usr/bin/env bash
# Runs the builder agent headless in a sandbox copy of the repository that holds no holdout
# material, no audit, no env file and no git history. Only targets/<t>/clone/ is copied back, so
# changes the builder makes to the evaluator in the sandbox never reach this repository.
# This is file-level isolation, not OS-level: the agent runs as the same user and could still
# reach the repository by absolute path. The guard hook runs inside the sandbox as a guardrail.
# Usage: harness/run-builder.sh <target> [extra instruction]
set -euo pipefail
target="$1"
extra="${2:-}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/rh-sandbox-$target-XXXX")"
mkdir -p "$repo/targets/$target/logs"
log="$repo/targets/$target/logs/builder-$stamp.log"

rsync -a \
  --exclude .git --exclude node_modules --exclude 'fixtures/holdout' --exclude 'holdout-*' \
  --exclude 'audit' --exclude '.scrub*' --exclude 'recon/out' --exclude 'targets/*/logs' --exclude '.env*' \
  "$repo/" "$sandbox/"
# A copy, not a link: a link would be a path back into the repository. APFS clones make it cheap.
cp -Rc "$repo/node_modules" "$sandbox/node_modules" 2>/dev/null || cp -R "$repo/node_modules" "$sandbox/node_modules"
trap 'rm -rf "$sandbox"' EXIT
if find "$sandbox" -path "$sandbox/node_modules" -prune -o \( -iname '*holdout*' -o -name '.env*' \) -print | grep -q .; then
  echo "refusing: holdout material or an env file found in the sandbox" >&2
  exit 2
fi

(cd "$sandbox" && RH_SANDBOX=1 claude -p "Use the builder subagent (Agent tool, subagent_type builder) on target '$target'. Pass it this task: implement targets/$target/clone/ until the dev fixtures pass, following .claude/agents/builder.md. $extra When it finishes, report its final summary verbatim, then run 'npm run verify $target' yourself and append the last line of its output." \
  --model claude-opus-5-5 \
  --permission-mode acceptEdits \
  --allowedTools "Bash Read Write Edit Grep Glob Agent" \
  --output-format text) | tee "$log"

rsync -a --delete "$sandbox/targets/$target/clone/" "$repo/targets/$target/clone/"
echo "copied back targets/$target/clone/ from $sandbox; verify in the repository with: npm run verify $target"
