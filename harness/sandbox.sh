#!/usr/bin/env bash
# Runs one agent headless inside the agent container, on a sandbox copy of the repository that
# holds no holdout, no audit material, no env or scrub files and no git history. The container
# sees only that copy (mounted at /work), not the host file system. The model credential comes
# from .agent.env through --env-file and is never written into the sandbox.
# Usage: harness/sandbox.sh <agent> <target> <task> [copy-back-dir]
# If copy-back-dir is given (for example targets/<t>/clone), that folder alone is copied back.
set -euo pipefail
agent="$1"
target="$2"
task="$3"
copy_back="${4:-}"
repo="$(cd "$(dirname "$0")/.." && pwd)"
image="software-clone-factory-agent"
credential="$repo/.agent.env"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
log="$repo/targets/$target/logs/$agent-$stamp.jsonl"

command -v docker >/dev/null || { echo "refusing: docker is required (OrbStack or Docker Desktop)" >&2; exit 2; }
[ -f "$credential" ] || { echo "refusing: $credential is missing (CLAUDE_CODE_OAUTH_TOKEN=...)" >&2; exit 2; }
docker image inspect "$image" >/dev/null 2>&1 || docker build -q -t "$image" -f "$repo/harness/docker/Dockerfile" "$repo" >/dev/null

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/scf-sandbox-$agent-XXXX")"
trap 'rm -rf "$sandbox"' EXIT
"$repo/harness/make-sandbox.sh" "$repo" "$sandbox"

# An analyst may see one spent batch, and only one recorded as spent in measurements.md (its single
# look already taken). It goes under spent/<batch>/, out of every holdout path and pattern.
if [ -n "${SPENT_BATCH:-}" ]; then
  [[ "$SPENT_BATCH" =~ ^hold[a-z0-9-]*$ ]] || { echo "refusing: bad batch name $SPENT_BATCH" >&2; exit 2; }
  grep -q "\`${SPENT_BATCH}-001\`" "$repo/targets/$target/measurements.md" 2>/dev/null \
    || { echo "refusing: batch $SPENT_BATCH has no recorded look in measurements.md" >&2; exit 2; }
  spent="$sandbox/targets/$target/spent/$SPENT_BATCH"
  mkdir -p "$spent"
  find "$repo/targets/$target/fixtures/holdout" -name "${SPENT_BATCH}-[0-9]*.json" -exec cp {} "$spent/" \;
  jq --arg b "$SPENT_BATCH" '[.cases[] | select(.pass | not) | .id | select(test("^" + $b + "-[0-9]+$"))]' \
    "$repo/targets/$target/verify/holdout-verdict.json" >"$spent/failures.json"
fi

mkdir -p "$repo/targets/$target/logs"
# Hours of agent work must not vanish with the sandbox: the clone is copied back even when the run
# fails, and the run's status is returned at the end.
status=0
docker run --rm \
  --env-file "$credential" -e RH_SANDBOX=1 \
  -v "$sandbox:/work" \
  "$image" \
  claude -p "Use the $agent subagent (Agent tool, subagent_type $agent) on target '$target' with this task, following .claude/agents/$agent.md: $task When it finishes, report its final answer verbatim." \
  --model claude-opus-5-5 \
  --permission-mode acceptEdits \
  --allowedTools "Bash Read Write Edit Grep Glob Agent WebFetch" \
  --output-format stream-json --verbose | tee "$log" | jq -rj 'select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text + "\n"' || status=$?

# The last line of the stream carries the run's totals: duration, turns, cost and tokens per model.
jq -c --arg agent "$agent" --arg stamp "$stamp" 'select(.type == "result")
  | {at: (now | todate), step: "agent", agent: $agent, log: ($agent + "-" + $stamp + ".jsonl"),
     seconds: (.duration_ms / 1000), turns: .num_turns, cost_usd: .total_cost_usd,
     usage: .usage, models: .modelUsage, ok: (.subtype == "success")}' "$log" \
  >>"$repo/targets/$target/timings.jsonl" || echo "warning: no result line in $log" >&2
# A build in a linked worktree is also logged in the main checkout, so its cost is never lost with it.
common="$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
own="$(git -C "$repo" rev-parse --path-format=absolute --git-dir 2>/dev/null || true)"
if [ -n "$common" ] && [ "$common" != "$own" ] && [ -f "$repo/targets/$target/timings.jsonl" ]; then
  tail -1 "$repo/targets/$target/timings.jsonl" | jq -c --arg w "$repo" '. + {worktree: $w}' \
    >>"$(dirname "$common")/targets/$target/timings.jsonl" || true
fi

if [ -n "$copy_back" ]; then
  # Only regular files come back: a symlink left in the sandbox could point at the real holdout once
  # it lands in the repository, so links are dropped and named.
  links="$(find "$sandbox/$copy_back" -type l 2>/dev/null || true)"
  [ -z "$links" ] || { echo "dropped symlinks (never copied back):" >&2; echo "$links" >&2; }
  rsync -a --no-links --delete "$sandbox/$copy_back/" "$repo/$copy_back/"
  echo "copied back $copy_back; score it in the repository with: npm run verify $target"
fi
exit "$status"
