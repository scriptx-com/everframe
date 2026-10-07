#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Builds Tests/GateAdmission/main.c against the actual gate source and runs it.
# The test disables recording and publishes another identifier between the
# report callback's first atomic load and its admission; it exits nonzero if
# that identifier is ever admitted. No vendor build is needed.
#
# Usage: Tests/gate-admission.sh /path/to/new-output
set -euo pipefail
output=${1:?usage: Tests/gate-admission.sh /path/to/new-output}
component=$(cd "$(dirname "$0")/.." && pwd)
owned="$component/Sources/EverframeCrashRecorder"
mkdir -p "$(dirname "$output")"
mkdir -m 700 "$output"
xcrun clang -std=gnu11 \
  -I "$owned" -I "$owned/include" \
  -I "$owned/Vendor/KSCrashCore/include" \
  -I "$owned/Vendor/KSCrashRecording/include" \
  -I "$owned/Vendor/KSCrashRecordingCore/include" \
  "$component/Tests/GateAdmission/main.c" -o "$output/gate-admission"
"$output/gate-admission"
