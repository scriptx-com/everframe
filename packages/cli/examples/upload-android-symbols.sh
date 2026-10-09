#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
# Invoke after a successful native build, listing every shipped library and ABI.
set -euo pipefail
if (( $# < 2 )); then
  echo 'Usage: upload-android-symbols.sh SYMBOLS_DIRECTORY BINARY [BINARY...]' >&2
  exit 64
fi
: "${EVERFRAME_APP_ID:?Set the app ID}"
: "${EVERFRAME_API_TOKEN:?Set a scoped artifacts:write token in CI secrets}"
symbols_directory=$1
shift
if [[ -n "${EVERFRAME_CLI_JS:-}" ]]; then
  uploader=(node "$EVERFRAME_CLI_JS")
else
  uploader=(everframe)
fi
uploader+=(elf upload-build "--app-id=$EVERFRAME_APP_ID" "--symbols-dir=$symbols_directory")
for binary in "$@"; do
  uploader+=("--binary=$binary")
done
"${uploader[@]}"
