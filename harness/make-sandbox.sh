#!/usr/bin/env bash
# Copies a repository into a sandbox folder without the material an implementer must never see:
# holdout fixtures and split files, audit material, env and scrub files, logs, raw recon output and
# git history. Refuses (exit 2) if any of it is still found in the copy afterwards.
# Usage: harness/make-sandbox.sh <source-repo> <sandbox-dir>
set -euo pipefail
src="$1"
dest="$2"
rsync -a \
  --exclude .git --exclude node_modules --exclude 'fixtures/holdout' --exclude 'holdout-*' \
  --exclude audit --exclude 'recon/out' --exclude 'targets/*/logs' --exclude '*.env' \
  --exclude '.env*' --exclude '.scrub*' \
  "$src/" "$dest/"
if find "$dest" \( -iname '*holdout*' -o -name '*.env' -o -name '.env*' -o -name '.scrub*' -o -name audit -o -name .git \) -print | grep -q .; then
  echo "refusing: holdout, audit, env, scrub or git material found in the sandbox" >&2
  exit 2
fi
