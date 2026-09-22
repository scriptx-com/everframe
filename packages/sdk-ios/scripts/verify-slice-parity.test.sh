#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Tests for `verify-slice-parity.sh` — the guard that would have stopped
# v0.6.6's tvOS-simulator slice from shipping a .swiftinterface with the whole
# branding API missing.
#
# A release gate nobody has seen fail is a gate nobody knows works, and this
# one cannot be exercised for real without a 20-minute four-SDK archive. So the
# fixtures below are hand-built xcframework trees: the guard only ever reads
# `<slice>/<Product>.framework/Modules/<Product>.swiftmodule/*.swiftinterface`,
# which is a directory layout and eight lines of text, not a binary.
#
# Case 4 is the one to keep. The tempting version of this check compares ALL
# slices to each other, and that is WRONG — TraceItXReporterUI's `PresentToken`
# is genuinely iOS-only (no on-device modal reporter on tvOS), so an all-slices
# check goes red on a perfectly good build. Every future widening of this guard
# has to keep case 4 green.
#
# Plain bash for the same reason as verify-binary-checksums.test.sh: the repo
# has no shell-test runner and two scripts do not justify adding one.
#
# Usage: packages/sdk-ios/scripts/verify-slice-parity.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="${SCRIPT_DIR}/verify-slice-parity.sh"
[[ -f "${SUT}" ]] || { echo "error: ${SUT} not found" 1>&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

PASS=0
FAIL=0

# --- fixture builder -------------------------------------------------------
# slice <xcframework-dir> <slice-id> <product> <arch>...  — reads the interface
# body from stdin and writes it as every named arch's .swiftinterface.
slice() {
    local xcf="$1" slice_id="$2" product="$3"; shift 3
    local modules="${xcf}/${slice_id}/${product}.framework/Modules/${product}.swiftmodule"
    local body arch
    mkdir -p "${modules}"
    body="$(cat)"
    for arch in "$@"; do
        printf '%s\n' "${body}" > "${modules}/${arch}.swiftinterface"
    done
}

# --- runner ----------------------------------------------------------------
run_case() {
    local name="$1"; shift
    OUTPUT="$("${SUT}" "$@" 2>&1)"
    STATUS=$?
    CASE_NAME="${name}"
}

ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() {
    FAIL=$((FAIL + 1))
    printf '  FAIL %s\n' "$1"
    printf '       %s\n' "$2"
    printf '       --- exit %s, output ---\n' "${STATUS}"
    printf '%s\n' "${OUTPUT}" | sed 's/^/       | /'
}

expect_status() {
    [[ "${STATUS}" == "$1" ]] && return 0
    bad "${CASE_NAME}" "expected exit $1, got ${STATUS}"
    return 1
}

expect_output() {
    [[ "${OUTPUT}" == *"$1"* ]] && return 0
    bad "${CASE_NAME}" "expected output to contain: $1"
    return 1
}

expect_no_output() {
    [[ "${OUTPUT}" != *"$1"* ]] && return 0
    bad "${CASE_NAME}" "expected output NOT to contain: $1"
    return 1
}

echo "verify-slice-parity.sh — slice interface parity tests"
echo

# ---------------------------------------------------------------------------
# 1. Device and simulator agree — the shape of every correct release.
# ---------------------------------------------------------------------------
X="${WORK}/1/Good.xcframework"
slice "${X}" tvos-arm64 Good arm64 <<'IFC'
public struct ReporterThemeOptions : Swift.Sendable {
  public let accent: Swift.String?
}
public func shouldShowWatermark(_ server: Good.BrandingConfigWire?) -> Swift.Bool
IFC
slice "${X}" tvos-arm64_x86_64-simulator Good arm64 x86_64 <<'IFC'
public struct ReporterThemeOptions : Swift.Sendable {
  public let accent: Swift.String?
}
public func shouldShowWatermark(_ server: Good.BrandingConfigWire?) -> Swift.Bool
IFC
run_case "matching slices pass" "${X}"
expect_status 0 && expect_output "1 simulator slice(s) match" && ok "${CASE_NAME}"

# ---------------------------------------------------------------------------
# 2. The v0.6.6 bug, reproduced: the simulator interface is a real interface
#    for the right product and arch, just built before the type existed.
# ---------------------------------------------------------------------------
X="${WORK}/2/Stale.xcframework"
slice "${X}" tvos-arm64 Stale arm64 <<'IFC'
public struct ReporterThemeOptions : Swift.Sendable {
  public let accent: Swift.String?
}
public enum CompanionState : Swift.String
IFC
slice "${X}" tvos-arm64_x86_64-simulator Stale arm64 x86_64 <<'IFC'
public enum CompanionState : Swift.String
IFC
run_case "stale simulator interface fails" "${X}"
expect_status 1 \
    && expect_output "public API of tvos-arm64_x86_64-simulator does not match tvos-arm64" \
    && expect_output "only in tvos-arm64: public struct ReporterThemeOptions" \
    && ok "${CASE_NAME}"

# ---------------------------------------------------------------------------
# 3. The copy was skipped outright for one slice. Two empty sets are "equal";
#    one empty set against a populated one must not be.
# ---------------------------------------------------------------------------
X="${WORK}/3/Missing.xcframework"
slice "${X}" ios-arm64 Missing arm64 <<'IFC'
public struct Thing : Swift.Sendable
IFC
mkdir -p "${X}/ios-arm64_x86_64-simulator/Missing.framework/Modules/Missing.swiftmodule"
run_case "absent simulator interface fails" "${X}"
expect_status 1 && expect_output "does not match ios-arm64" && ok "${CASE_NAME}"

# ---------------------------------------------------------------------------
# 4. REGRESSION GUARD. iOS declares a type tvOS does not (the real
#    TraceItXReporterUI.PresentToken case). Each platform's simulator matches
#    its own device slice, so this artifact is correct and must pass.
# ---------------------------------------------------------------------------
X="${WORK}/4/CrossPlatform.xcframework"
for id in ios-arm64 ios-arm64_x86_64-simulator; do
    archs=(arm64); [[ "${id}" == *simulator ]] && archs=(arm64 x86_64)
    slice "${X}" "${id}" CrossPlatform "${archs[@]}" <<'IFC'
public struct Shared : Swift.Sendable
public struct PresentToken : Swift.Hashable
IFC
done
for id in tvos-arm64 tvos-arm64_x86_64-simulator; do
    archs=(arm64); [[ "${id}" == *simulator ]] && archs=(arm64 x86_64)
    slice "${X}" "${id}" CrossPlatform "${archs[@]}" <<'IFC'
public struct Shared : Swift.Sendable
IFC
done
run_case "iOS-only API does not fail tvOS" "${X}"
expect_status 0 && expect_output "2 simulator slice(s) match" && ok "${CASE_NAME}"

# ---------------------------------------------------------------------------
# 5. @_spi consumers compile against the .private.swiftinterface, so it is a
#    published surface too — a divergence there alone must still fail.
# ---------------------------------------------------------------------------
X="${WORK}/5/Spi.xcframework"
slice "${X}" ios-arm64 Spi arm64 <<'IFC'
public struct Shared : Swift.Sendable
IFC
slice "${X}" ios-arm64_x86_64-simulator Spi arm64 x86_64 <<'IFC'
public struct Shared : Swift.Sendable
IFC
printf '%s\n' 'public struct Internals : Swift.Sendable' \
    > "${X}/ios-arm64/Spi.framework/Modules/Spi.swiftmodule/arm64.private.swiftinterface"
printf '%s\n' '' \
    > "${X}/ios-arm64_x86_64-simulator/Spi.framework/Modules/Spi.swiftmodule/arm64.private.swiftinterface"
run_case "private interface divergence fails" "${X}"
expect_status 1 \
    && expect_output "private API of ios-arm64_x86_64-simulator" \
    && expect_no_output "public API of ios-arm64_x86_64-simulator" \
    && ok "${CASE_NAME}"

# ---------------------------------------------------------------------------
# 6. A device-only xcframework verifies nothing. Silence would read as a pass
#    and is exactly how a gate rots — say so and go red.
# ---------------------------------------------------------------------------
X="${WORK}/6/DeviceOnly.xcframework"
slice "${X}" ios-arm64 DeviceOnly arm64 <<'IFC'
public struct Shared : Swift.Sendable
IFC
run_case "no simulator slices fails loudly" "${X}"
expect_status 1 && expect_output "no simulator slices found" && ok "${CASE_NAME}"

# ---------------------------------------------------------------------------
# 7. Normalisation. Xcode's emitters wrap and indent differently across
#    versions and archs; only the DECLARATIONS may drive the verdict. A guard
#    that trips on whitespace gets disabled the first time it cries wolf.
# ---------------------------------------------------------------------------
X="${WORK}/7/Noise.xcframework"
slice "${X}" ios-arm64 Noise arm64 <<'IFC'
public struct Thing : Swift.Sendable {
  public init(accent: Swift.String? = nil)
  public func render(into target: Swift.String) -> Swift.Bool
}
IFC
slice "${X}" ios-arm64_x86_64-simulator Noise arm64 x86_64 <<'IFC'
public struct Thing   :   Swift.Sendable {
    public func render(into  target: Swift.String, extra: Swift.Int = 3) -> Swift.Bool
    public init(accent: Swift.String? = "#fff")
}
IFC
run_case "whitespace, order and defaults are not API changes" "${X}"
expect_status 0 && ok "${CASE_NAME}"

echo
echo "  ${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]] || exit 1
