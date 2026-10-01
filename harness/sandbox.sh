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
log="$repo/targets/$target/logs/$agent-$stamp.log"

command -v docker >/dev/null || { echo "refusing: docker is required (OrbStack or Docker Desktop)" >&2; exit 2; }
[ -f "$credential" ] || { echo "refusing: $credential is missing (CLAUDE_CODE_OAUTH_TOKEN=...)" >&2; exit 2; }
docker image inspect "$image" >/dev/null 2>&1 || docker build -q -t "$image" -f "$repo/harness/docker/Dockerfile" "$repo" >/dev/null

sandbox="$(mktemp -d "${TMPDIR:-/tmp}/scf-sandbox-$agent-XXXX")"
trap 'rm -rf "$sandbox"' EXIT
"$repo/harness/make-sandbox.sh" "$repo" "$sandbox"

mkdir -p "$repo/targets/$target/logs"
docker run --rm \
  --env-file "$credential" -e RH_SANDBOX=1 \
  -v "$sandbox:/work" \
  "$image" \
  claude -p "Use the $agent subagent (Agent tool, subagent_type $agent) on target '$target' with this task, following .claude/agents/$agent.md: $task When it finishes, report its final answer verbatim." \
  --model claude-opus-5-5 \
  --permission-mode acceptEdits \
  --allowedTools "Bash Read Write Edit Grep Glob Agent WebFetch" \
  --output-format text | tee "$log"

if [ -n "$copy_back" ]; then
  rsync -a --delete "$sandbox/$copy_back/" "$repo/$copy_back/"
  echo "copied back $copy_back; score it in the repository with: npm run verify $target"
fi
