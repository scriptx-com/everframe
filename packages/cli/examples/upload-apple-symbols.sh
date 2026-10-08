#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
# Run only after the build/archive succeeds. Every binary listed is required.
set -euo pipefail
if (( $# < 2 )); then
  echo 'Usage: upload-apple-symbols.sh DSYM_DIRECTORY BINARY [BINARY...]' >&2
  exit 64
fi
: "${EVERFRAME_APP_ID:?Set the app ID}"
: "${EVERFRAME_API_TOKEN:?Set a scoped artifacts:write token in CI secrets}"
dsym_directory=$1
shift
if [[ -n "${EVERFRAME_CLI_JS:-}" ]]; then
  uploader=(node "$EVERFRAME_CLI_JS")
else
  uploader=(everframe)
fi
uploader+=(dsym upload-build "--app-id=$EVERFRAME_APP_ID" "--dsym-dir=$dsym_directory")
for binary in "$@"; do
  uploader+=("--binary=$binary")
done
"${uploader[@]}"
