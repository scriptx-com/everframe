#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
# Run after `xcodebuild archive` (or fastlane build_app) succeeds.
set -euo pipefail
if (( $# != 1 )); then
  echo 'Usage: upload-apple-symbols.sh PATH.xcarchive' >&2
  exit 64
fi
: "${EVERFRAME_APP_ID:?Set the app ID}"
if [[ -n "${EVERFRAME_CLI_JS:-}" ]]; then
  uploader=(node "$EVERFRAME_CLI_JS")
else
  uploader=(npx --yes @everframe/cli)
fi
# Without EVERFRAME_API_TOKEN, or when the upload fails, this warns and exits 0.
# Set EVERFRAME_SYMBOLS_STRICT=1 to fail the pipeline instead.
"${uploader[@]}" dsym upload-build --archive "$1"
