#!/bin/bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# The "Upload Everframe Build Artifacts" Run Script phase that `everframe setup react-native`
# and @everframe/expo add to the app target runs this script in one line:
#
#   "${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh" --app-id "<App ID>"
#
# It runs `everframe xcode build-phase` from this package with the same arguments. That
# command uploads the Hermes source map and the dSYMs of the build. Debug and SKIP_BUNDLING
# builds skip before Node starts. When Node is missing or the CLI fails, the script prints a
# `warning:` line and the build continues. With EVERFRAME_SYMBOLS_STRICT=1 (or true) it
# fails the build instead.

if [ "${CONFIGURATION:-}" = "Debug" ] || [ -n "${SKIP_BUNDLING:-}" ]; then
  echo "everframe: Debug build, skipping artifact upload"
  exit 0
fi

everframe_strict=0
case "${EVERFRAME_SYMBOLS_STRICT:-}" in 1|true) everframe_strict=1;; esac

# A build started from the Xcode app has a short PATH.
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
# The project's .xcode.env files set NODE_BINARY, as for React Native's own phases.
if [ -f "${SRCROOT:-}/.xcode.env" ]; then . "$SRCROOT/.xcode.env"; fi
if [ -f "${SRCROOT:-}/.xcode.env.local" ]; then . "$SRCROOT/.xcode.env.local"; fi

everframe_skip() {
  if [ "$everframe_strict" = 1 ]; then
    echo "error: everframe: $1"
    exit 1
  fi
  echo "warning: everframe: $1 Build artifacts were not uploaded and the build continues. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead."
  exit 0
}

everframe_node="${NODE_BINARY:-node}"
if ! command -v "$everframe_node" >/dev/null 2>&1; then
  everframe_skip "Node was not found (NODE_BINARY=$everframe_node). Set NODE_BINARY in ios/.xcode.env.local."
fi

# This file is scripts/xcode-upload.sh inside the installed package, wherever it was hoisted.
"$everframe_node" "$(dirname "$0")/../dist/index.js" xcode build-phase "$@"
everframe_status=$?
if [ "$everframe_status" = 0 ]; then exit 0; fi
if [ "$everframe_strict" = 1 ]; then exit "$everframe_status"; fi
everframe_skip "@everframe/cli stopped with exit status $everframe_status."
