#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Assert that every SIMULATOR slice of an .xcframework declares the same public
# Swift API as the DEVICE slice of the same platform.
#
# Why this exists. `build-xcframework.sh` cannot let xcodebuild place the
# .swiftinterface inside the framework (Xcode 26.5 + the XcodeGen project skip
# that step under BUILD_LIBRARIES_FOR_DISTRIBUTION), so it copies each one out
# of the build intermediates by hand. Every bug that copy has had — twice now,
# v0.1.1 and v0.6.6 — has been the same shape: the binary, .swiftdoc and
# .abi.json come from the archive and are correct, while the .swiftinterface
# beside them was copied from the wrong build. Nothing downstream notices,
# because CocoaPods checks a zip hash and SwiftPM checks a checksum; the first
# report is a consumer whose build fails with "cannot find type X in scope" for
# a type the release notes say shipped. v0.6.6 reached npm that way.
#
# The invariant this checks is the tightest one that is actually TRUE of these
# artifacts. Device-vs-simulator is a legitimate comparison because both slices
# compile the same sources with the same conditionals — `#if targetEnvironment
# (simulator)` is not used to gate public API anywhere in this SDK. iOS-vs-tvOS
# is NOT: TraceItXReporterUI's `PresentToken` is iOS-only by design (the tvOS
# on-device modal reporter was removed; tvOS routes through the phone
# companion), so a cross-platform check would fail on correct artifacts.
#
# Usage: verify-slice-parity.sh <Foo.xcframework> [<Bar.xcframework> ...]
set -euo pipefail

if [[ $# -eq 0 ]]; then
    echo "usage: $(basename "$0") <path/to/Foo.xcframework> [...]" 1>&2
    exit 2
fi

# Public API surface of one .swiftinterface, as a sorted set of declaration
# lines truncated at the first `{`, `(` or `=` — so a body, a parameter list or
# a default value can't make two identical declarations compare unequal.
# Matched anywhere on the line rather than anchored, because attributes prefix
# the keyword (`@objc public final class`, `@available(...) public func`).
interface_symbols() {
    # NB: squeeze spaces and tabs only. `tr -s '[:space:]'` folds the newlines
    # too, collapsing the whole interface into a single "symbol".
    # `|| true`: an interface with no public declarations is a legitimate
    # input (and the exact shape of a half-copied one), but grep exits 1 on no
    # match, which under `set -e` + pipefail would abort the whole run with an
    # empty error message instead of reporting the mismatch.
    { grep -ohE '\b(public|open)\b[^={(]*' "$@" 2>/dev/null || true; } \
        | tr -s ' \t' ' ' \
        | sed 's/[[:space:]]*$//' \
        | sort -u
}

# Union of the API across every arch in a slice. Archs within a slice must
# agree with each other too; folding them into one set means a divergence
# there also shows up as a difference against the device slice.
slice_symbols() {
    local slice_dir="$1" kind="$2" files
    if [[ "${kind}" == "private" ]]; then
        files="$(find "${slice_dir}" -name '*.private.swiftinterface' 2>/dev/null)"
    else
        files="$(find "${slice_dir}" -name '*.swiftinterface' -not -name '*.private.swiftinterface' 2>/dev/null)"
    fi
    [[ -z "${files}" ]] && return 0
    # shellcheck disable=SC2086
    interface_symbols ${files}
}

status=0

for xcf in "$@"; do
    if [[ ! -d "${xcf}" ]]; then
        echo "error: ${xcf} is not a directory" 1>&2
        exit 2
    fi
    name="$(basename "${xcf}" .xcframework)"

    checked=0
    failed=0
    for sim in "${xcf}"/*-simulator; do
        [[ -d "${sim}" ]] || continue
        sim_id="$(basename "${sim}")"
        platform="${sim_id%%-*}"

        # Device counterpart: same platform, no variant suffix. maccatalyst is
        # a variant of ios, not a device slice, so it is excluded explicitly
        # rather than by luck of the glob.
        device=""
        for cand in "${xcf}/${platform}"-*; do
            [[ -d "${cand}" ]] || continue
            case "$(basename "${cand}")" in
                *-simulator|*-maccatalyst) continue ;;
            esac
            device="${cand}"
            break
        done
        if [[ -z "${device}" ]]; then
            echo "    ${name}/${sim_id}: no device slice for platform '${platform}' — skipped"
            continue
        fi
        device_id="$(basename "${device}")"

        for kind in public private; do
            dev_syms="$(slice_symbols "${device}" "${kind}")"
            sim_syms="$(slice_symbols "${sim}" "${kind}")"

            # An interface present on one side and absent on the other is the
            # copy having been skipped entirely — same defect class, and it
            # would otherwise read as "both empty, therefore equal".
            if [[ -z "${dev_syms}" && -z "${sim_syms}" ]]; then
                continue
            fi

            if [[ "${dev_syms}" != "${sim_syms}" ]]; then
                echo "error: ${name}: ${kind} API of ${sim_id} does not match ${device_id}" 1>&2
                echo "       The .swiftinterface in one of these slices was copied from the" 1>&2
                echo "       wrong build. Do NOT publish this artifact." 1>&2
                diff <(printf '%s\n' "${dev_syms}") <(printf '%s\n' "${sim_syms}") \
                    | sed -e "s|^<|       only in ${device_id}:|" \
                          -e "s|^>|       only in ${sim_id}:|" \
                    | grep -E '^       only in' 1>&2 || true
                status=1
                failed=1
            fi
        done
        checked=$((checked + 1))
    done

    if [[ "${checked}" -eq 0 ]]; then
        echo "error: ${name}: no simulator slices found — nothing was verified" 1>&2
        status=1
    elif [[ "${failed}" -eq 0 ]]; then
        echo "    ${name}: ${checked} simulator slice(s) match their device counterpart"
    fi
done

exit "${status}"
