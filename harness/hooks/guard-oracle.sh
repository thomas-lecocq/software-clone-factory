#!/usr/bin/env bash
# PreToolUse guard: a best-effort guardrail that keeps implementer agents away from the evaluator
# and logs every blocked attempt. It matches strings, so a determined agent with a shell can get
# around it; the stronger measures are the sandbox without holdout files and the committed lock.
# Exit 2 blocks the tool call and shows stderr to the agent.
set -euo pipefail
# Fail closed: an unexpected error must block (exit 2), never fall through to exit 1, which allows.
trap 'echo "blocked by guard-oracle: internal error" >&2; exit 2' ERR
shopt -s nocasematch # macOS file systems are case-insensitive, so the matching must be too
input="$(cat)"
tool="$(jq -r '.tool_name // ""' <<<"$input")"
role="$(jq -r '.agent_type // "main"' <<<"$input")"
# For file tools only the path fields count: the text being written may mention anything.
if [[ "$tool" =~ ^(Write|Edit|MultiEdit|NotebookEdit)$ ]]; then
  target="$(jq -r '[.tool_input.file_path, .tool_input.notebook_path] | map(select(. != null)) | join(" ")' <<<"$input")"
elif [[ "$tool" == "Bash" ]]; then
  # The command alone: its free-text description is not something the shell runs.
  target="$(jq -r '.tool_input.command // ""' <<<"$input")"
else
  target="$(jq -r '.tool_input // {} | [.. | strings] | join(" ")' <<<"$input")"
fi
log="${GUARD_LOG:-$(dirname "$0")/../../logs/guard.log}"

block() {
  # Logging must never decide the outcome: a failed write here would exit 1, which Claude Code
  # treats as "allow". The block below always runs.
  { mkdir -p "$(dirname "$log")" && printf '%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$role" "$tool" "$1" >>"$log"; } 2>/dev/null || true
  echo "blocked by guard-oracle: $1" >&2
  exit 2
}

# Default deny for subagents: any agent other than the recorder is treated as an implementer.
# Inside a builder sandbox nobody is exempt: there the top-level session is an implementer too.
if [[ "${RH_SANDBOX:-}" != "1" ]]; then
  case "$role" in
    main | recorder) exit 0 ;;
  esac
fi

oracle='(fixtures/|fixtures\.lock|policy\.json|rules\.json|(^|[ /])harness/|/verify/|docs/verification\.md|npm run record|cli\.ts (record|relock|explain))'

# Shell escapes that no pattern list can follow: nested sessions, eval, git history, links.
if [[ "$tool" == "Bash" ]] && [[ "$target" =~ (^|[^a-z])(claude|eval|base64|ln)[[:space:]] || "$target" =~ git([[:space:]]+-[^[:space:]]+([[:space:]]+[^-[:space:]][^[:space:]]*)?)*[[:space:]]+(show|log|grep|diff|cat-file|checkout|restore|stash|blame|reflog) ]]; then
  block "$role cannot run nested sessions, eval, links or read git history"
fi
# The harness configuration and dependencies shape the evaluation too, by any route.
if [[ "$tool" == "Bash" ]] && [[ "$target" =~ (\.claude/|node_modules/|package(-lock)?\.json) ]] && [[ "$target" =~ (\>|tee |dd |mv |cp |rm |install |rsync |sed -i|perl -i|writeFile|appendFile|open\(|npm (i|install|uninstall)) ]]; then
  block "$role cannot modify agent definitions, hooks, package manifests or dependencies"
fi
if [[ "$tool" =~ ^(Write|Edit|MultiEdit|NotebookEdit)$ ]] && [[ "$target" =~ (\.claude/|package(-lock)?\.json|node_modules/) ]]; then
  block "$role cannot modify agent definitions, hooks, package manifests or dependencies"
fi
if [[ "$role" == "breaker" && "$tool" == "Bash" ]] && [[ "$target" =~ (\>|tee |dd |mv |cp |rm |install |rsync |sed -i|perl -i|writeFile|appendFile|open\() ]]; then
  block "the breaker is read-only"
fi
# A search rooted at a target (or any recursive glob) reaches the holdout unless it is scoped to
# the dev fixtures, the clone, or the one spent batch an analyst's sandbox holds.
if [[ "$tool" =~ ^(Grep|Glob)$ ]] && [[ "$target" == *targets* || "$target" == *"**"* ]] && [[ "$target" != *fixtures/dev* && "$target" != */clone* && "$target" != */spent/* ]]; then
  block "$role must scope searches to fixtures/dev/, clone/ or spent/"
fi
# Once the repository is public, its holdout fixtures are one request away: code hosts and package
# registries' source views are out of bounds for implementers, by any tool.
if [[ "$target" =~ (github\.com|githubusercontent\.com|gitlab\.com|bitbucket\.org|sourcegraph\.com|software-clone-factory) ]] && [[ "$tool" =~ ^(WebFetch|WebSearch|Bash)$ ]]; then
  block "$role cannot fetch from code hosts"
fi
# Audit prompts and the planted-defect library would tell an implementer what is checked.
if [[ "$target" == *audit/* || "$target" =~ (^|[[:space:]])audit($|[[:space:]]) ]]; then
  block "$role cannot read audit material"
fi
# Anything named holdout is hidden from subagents, whatever the tool (files, globs, commands).
if [[ "$target" == *holdout* || "$target" == *hold\** || "$target" == *hol\** ]]; then
  block "$role cannot read holdout material"
fi
# Relative escapes are resolved by nobody here, so they are refused outright.
if [[ "$target" == *../* || "$target" == *..\\* ]]; then
  block "$role cannot use .. in paths"
fi
# Fixtures may be read only through the dev folder: a glob or grep over fixtures/ reaches the holdout.
fixtures_any='fixtures(/?$|/?[[:space:]"'"'"']|/([^d]|d[^e]|de[^v]|dev[^/]))'
if [[ "$target" =~ $fixtures_any ]]; then
  block "$role can read fixtures only under fixtures/dev/"
fi
# The explain and relock commands print holdout diffs or rewrite the lock.
if [[ "$target" =~ (cli\.ts|npm run) ]] && [[ "$target" =~ (explain|relock|record) ]]; then
  block "$role cannot run record, relock or explain"
fi
writes='^(Write|Edit|MultiEdit|NotebookEdit)$'

if [[ "$tool" =~ $writes ]] && [[ "$target" =~ $oracle ]]; then
  block "$role cannot modify the evaluator ($target)"
fi
# Inside a target, implementers write only the clone: the adapter and probes drive the evaluation.
# The analyst writes only its report.
if [[ "$role" == "analyst" && "$tool" =~ $writes ]] && [[ "$target" != */analysis/* && "$target" != /tmp/* ]]; then
  block "the analyst writes only its report under targets/<t>/analysis/, and scratch files in /tmp ($target)"
fi
if [[ "$role" == "analyst" && "$tool" =~ $writes ]]; then
  exit 0
fi
if [[ "$tool" =~ $writes ]] && [[ "$target" == *targets/* ]] && [[ "$target" != */clone/* ]]; then
  block "$role can only write under targets/<t>/clone/ ($target)"
fi
# Shell writes: a redirect whose target is an evaluator path, or a writing command naming one.
# Plain reads (cat, jq, grep, `2>/dev/null`, `=>` in inline code) stay allowed.
redirect='>>?[[:space:]]*[^[:space:]]*(fixtures/|fixtures\.lock|policy\.json|rules\.json|harness/|/verify/)'
if [[ "$tool" == "Bash" ]] && { [[ "$target" =~ $redirect ]] || { [[ "$target" =~ $oracle ]] && [[ "$target" =~ (sed -i|tee |mv |cp |rm |perl -i|record|git checkout|git restore|writeFile|open\(|python|ruby|perl |truncate |chmod |dd |install ) ]]; }; }; then
  block "$role cannot modify the evaluator through the shell"
fi
# The target's driver code (adapter, probes, drivers) runs on both sides, so it shapes the score:
# a shell write to a target's top-level .ts file is blocked like a Write on it. Reads stay allowed.
driver='targets/[^/[:space:]]+/[^/[:space:]]+\.ts'
if [[ "$tool" == "Bash" ]] && { [[ "$target" =~ \>\>?[[:space:]]*[^[:space:]]*$driver ]] || { [[ "$target" =~ $driver ]] && [[ "$target" =~ (sed -i|tee |mv |cp |rm |perl -i|truncate |dd |writeFile) ]]; }; }; then
  block "$role cannot modify the target's driver code through the shell"
fi
if [[ "$target" == *fixtures/holdout* ]]; then
  block "$role cannot read holdout fixtures"
fi
if [[ "$role" == "breaker" && "$tool" =~ $writes ]]; then
  block "the breaker is read-only"
fi
exit 0
