#!/usr/bin/env bash
# Runs one of the project's agents headless in a sandbox copy of the repository with no holdout,
# no audit and no git history (see run-builder.sh). Nothing is copied back: the agent's answer is
# the log. Usage: harness/run-agent.sh <agent> <target> <task>
set -euo pipefail
agent="$1"
target="$2"
task="$3"
repo="$(cd "$(dirname "$0")/.." && pwd)"
sandbox="$(mktemp -d "${TMPDIR:-/tmp}/rh-sandbox-$agent-XXXX")"
mkdir -p "$repo/targets/$target/logs"
log="$repo/targets/$target/logs/$agent-$(date -u +%Y%m%dT%H%M%SZ).log"
rsync -a \
  --exclude .git --exclude node_modules --exclude 'fixtures/holdout' --exclude 'holdout-*' \
  --exclude 'audit' --exclude '.scrub*' --exclude 'recon/out' --exclude 'targets/*/logs' --exclude '.env*' \
  "$repo/" "$sandbox/"
# A copy, not a link: a link would be a path back into the repository. APFS clones make it cheap.
cp -Rc "$repo/node_modules" "$sandbox/node_modules" 2>/dev/null || cp -R "$repo/node_modules" "$sandbox/node_modules"
trap 'rm -rf "$sandbox"' EXIT
(cd "$sandbox" && RH_SANDBOX=1 claude -p "Use the $agent subagent (Agent tool, subagent_type $agent) on target '$target' with this task, following .claude/agents/$agent.md: $task When it finishes, report its final answer verbatim." \
  --model claude-opus-5-5 \
  --permission-mode acceptEdits \
  --allowedTools "Bash Read Write Edit Grep Glob Agent WebFetch" \
  --output-format text) | tee "$log"
