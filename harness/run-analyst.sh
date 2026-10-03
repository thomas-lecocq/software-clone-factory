#!/usr/bin/env bash
# Runs the analyst agent on a spent holdout batch (see harness/sandbox.sh): the sandbox receives
# that batch's fixtures and failing IDs under targets/<t>/spent/<batch>/, and no other holdout
# material; only targets/<t>/analysis/ comes back. The failing IDs come from the latest holdout run
# (verify/holdout-verdict.json), so run it right after the batch's single look.
# Usage: harness/run-analyst.sh <target> <batch prefix, e.g. hold or hold-b2>
set -euo pipefail
target="$1"
batch="$2"
export SPENT_BATCH="$batch"
exec "$(dirname "$0")/sandbox.sh" analyst "$target" \
  "analyse the failures of spent holdout batch '$batch' (targets/$target/spent/$batch/) and write targets/$target/analysis/$batch-failures.md." \
  "targets/$target/analysis"
