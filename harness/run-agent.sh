#!/usr/bin/env bash
# Runs another agent (breaker, recorder draft) in the agent container; nothing is copied back, the
# answer is the log. Usage: harness/run-agent.sh <agent> <target> <task>
set -euo pipefail
exec "$(dirname "$0")/sandbox.sh" "$1" "$2" "$3"
