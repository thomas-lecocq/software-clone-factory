#!/usr/bin/env bash
# Runs the builder agent in the agent container (see harness/sandbox.sh); only the target's clone
# folder comes back. Usage: harness/run-builder.sh <target> [extra instruction]
set -euo pipefail
target="$1"
extra="${2:-}"
exec "$(dirname "$0")/sandbox.sh" builder "$target" \
  "implement targets/$target/clone/ until the dev fixtures pass. $extra Then run 'npm run verify $target' and report its last line." \
  "targets/$target/clone"
