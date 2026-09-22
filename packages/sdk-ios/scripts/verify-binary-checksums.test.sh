#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Tests for `verify-binary-checksums.sh` — specifically its FETCH modes, which
# are the ones nothing had ever exercised.
#
# Why this file exists at all. The release gate had a URL-construction bug that
# survived review because the only mode anyone ran was `--dist`, and `--dist`
# never builds a URL. Every "verification" of the guard therefore ran the one
# path that skips the code being guarded. These tests do the opposite: they run
# the fetch path, with no network, and assert on the URLs it actually requests.
#
# Why plain bash and not a framework. The repo has no shell-test runner (no
# bats, no shunit2) and one script does not justify introducing one plus a
# toolchain dependency on every CI runner. The whole harness is the ~40 lines
# below; `run_case` is the entire API.
#
# Two techniques carry it:
#
#   * a FIXTURE package dir. The script derives PKG_DIR from its own location,
#     so a copy of it placed in a throwaway tree reads throwaway manifests. That
#     lets a test state a deliberately broken `baseURL` without touching the
#     real one.
#   * a FAKE curl on PATH. It records every requested URL to a file and answers
#     404, so the tests are hermetic AND can assert the exact bytes of the URL —
#     the property under test — rather than inferring it from an exit code.
#
# Usage: packages/sdk-ios/scripts/verify-binary-checksums.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="${SCRIPT_DIR}/verify-binary-checksums.sh"
[[ -f "${SUT}" ]] || { echo "error: ${SUT} not found" 1>&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

PASS=0
FAIL=0

# --- fake curl -------------------------------------------------------------
# Mimics the two invocation shapes the script uses (-o FILE ... URL and
# -o /dev/null ... URL), logs the URL, writes an empty body, prints 404.
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""
out=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o) out="$2"; shift ;;
        -w|--retry|--retry-delay) shift ;;
        -*) ;;
        *) url="$1" ;;
    esac
    shift
done
printf '%s\n' "${url}" >> "${CURL_LOG}"
[[ -n "${out}" ]] && : > "${out}"
printf '%s' "${FAKE_CURL_CODE:-404}"
FAKE
chmod +x "${WORK}/bin/curl"

# --- fixture builder -------------------------------------------------------
# $1 dir, $2 binaryVersion, $3 baseURL literal (as it appears inside the quotes)
make_fixture() {
    local dir="$1" version="$2" base="$3"
    mkdir -p "${dir}/scripts"
    cp "${SUT}" "${dir}/scripts/"
    cat > "${dir}/Package.binary.swift" <<EOF
// swift-tools-version: 5.9
import PackageDescription

let binaryVersion = "${version}"
let baseURL = "${base}"

let package = Package(
    name: "TraceItX",
    targets: [
        .binaryTarget(
            name: "TraceItXKit",
            url: baseURL + "TraceItXKit.xcframework.zip",
            checksum: "1111111111111111111111111111111111111111111111111111111111111111"
        ),
        .binaryTarget(
            name: "TraceItXProtocol",
            url: baseURL + "TraceItXProtocol.xcframework.zip",
            checksum: "2222222222222222222222222222222222222222222222222222222222222222"
        ),
    ]
)
EOF
    cat > "${dir}/TraceItX.podspec" <<EOF
Pod::Spec.new do |spec|
  spec.name    = "TraceItX"
  spec.version = "${version}"
  spec.source  = { :http => "https://example.invalid/v#{spec.version}/TraceItX-#{spec.version}.zip" }
end
EOF
}

# --- runner ----------------------------------------------------------------
# run_case <name> <fixture-dir> [args...] -> sets STATUS, OUTPUT, URLS
run_case() {
    local name="$1" dir="$2"; shift 2
    CURL_LOG="${WORK}/urls.$$"
    : > "${CURL_LOG}"
    export CURL_LOG
    OUTPUT="$(PATH="${WORK}/bin:${PATH}" "${dir}/scripts/verify-binary-checksums.sh" "$@" 2>&1)"
    STATUS=$?
    URLS="$(cat "${CURL_LOG}")"
    CASE_NAME="${name}"
}

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad()  {
    FAIL=$((FAIL + 1))
    printf '  FAIL %s\n' "$1"
    printf '       %s\n' "$2"
    printf '       --- exit %s, output ---\n' "${STATUS}"
    printf '%s\n' "${OUTPUT}" | sed 's/^/       | /'
    printf '       --- urls requested ---\n'
    printf '%s\n' "${URLS:-<none>}" | sed 's/^/       | /'
}

expect_status() {
    if [[ "${STATUS}" == "$1" ]]; then return 0; fi
    bad "${CASE_NAME}" "expected exit $1, got ${STATUS}"
    return 1
}

echo "verify-binary-checksums.sh — fetch-mode tests"
echo

# ---------------------------------------------------------------------------
# 1. The happy path this whole finding was about: Swift interpolation in the
#    manifest must become a real version in every URL the script requests.
#    `--dist` cannot cover this; only a fetch mode can.
# ---------------------------------------------------------------------------
GOOD="${WORK}/good"
make_fixture "${GOOD}" "9.9.9" 'https://example.invalid/download/v\(binaryVersion)/'

run_case "resolves \\(binaryVersion) in every requested URL" "${GOOD}" --allow-unpublished
if expect_status 0; then
    if [[ -z "${URLS}" ]]; then
        bad "${CASE_NAME}" "no URL was requested at all"
    elif printf '%s' "${URLS}" | grep -q 'binaryVersion'; then
        bad "${CASE_NAME}" "a requested URL still contains the literal placeholder"
    elif [[ "$(printf '%s\n' "${URLS}" | grep -c '/v9\.9\.9/')" != "$(printf '%s\n' "${URLS}" | grep -c .)" ]]; then
        bad "${CASE_NAME}" "not every requested URL carried /v9.9.9/"
    else
        ok "${CASE_NAME}"
    fi
fi

# ---------------------------------------------------------------------------
# 2. `--version` must steer the URLs, not just the log line.
# ---------------------------------------------------------------------------
run_case "--version 1.2.3 aims the URLs at that release" "${GOOD}" --version 1.2.3 --allow-unpublished
if expect_status 0; then
    if printf '%s' "${URLS}" | grep -qv '/v1\.2\.3/'; then
        bad "${CASE_NAME}" "some URL did not use the overridden version"
    else
        ok "${CASE_NAME}"
    fi
fi

# ---------------------------------------------------------------------------
# 3. THE ENFORCEMENT TEST. A manifest the substitution does not understand
#    (here: the constant renamed) must stop the run BEFORE any request. This is
#    the case that used to sail through as "UNPUBLISHED".
# ---------------------------------------------------------------------------
BROKEN="${WORK}/broken"
make_fixture "${BROKEN}" "9.9.9" 'https://example.invalid/download/v\(releaseVersion)/'

run_case "unresolvable placeholder is a hard failure" "${BROKEN}"
if [[ "${STATUS}" == 0 ]]; then
    bad "${CASE_NAME}" "expected a non-zero exit, got 0"
elif [[ -n "${URLS}" ]]; then
    bad "${CASE_NAME}" "it fetched a nonsense URL instead of refusing to start"
elif ! printf '%s' "${OUTPUT}" | grep -q 'placeholder survived unexpanded'; then
    bad "${CASE_NAME}" "the error does not name the placeholder problem"
else
    ok "${CASE_NAME}"
fi

# ---------------------------------------------------------------------------
# 4. THE FALSE-PASS TEST. `--allow-unpublished` exists to forgive a 404 from a
#    release that is not up yet. A bad URL 404s identically, so the flag must
#    NOT be able to launder one into exit 0.
# ---------------------------------------------------------------------------
run_case "--allow-unpublished cannot forgive a bad URL" "${BROKEN}" --allow-unpublished
if [[ "${STATUS}" == 0 ]]; then
    bad "${CASE_NAME}" "--allow-unpublished turned a malformed URL into a pass"
elif [[ -n "${URLS}" ]]; then
    bad "${CASE_NAME}" "it fetched a nonsense URL instead of refusing to start"
else
    ok "${CASE_NAME}"
fi

# ---------------------------------------------------------------------------
# 5. A baseURL with no placeholder at all — pinned to a stale release — is the
#    same defect wearing a well-formed URL. The version-containment half of the
#    self-check is what catches it.
# ---------------------------------------------------------------------------
STALE="${WORK}/stale"
make_fixture "${STALE}" "9.9.9" 'https://example.invalid/download/v0.4.5/'

run_case "baseURL pinned to another version is a hard failure" "${STALE}" --allow-unpublished
if [[ "${STATUS}" == 0 ]]; then
    bad "${CASE_NAME}" "a URL for the wrong release was accepted"
elif ! printf '%s' "${OUTPUT}" | grep -q 'does not mention version 9.9.9'; then
    bad "${CASE_NAME}" "the error does not explain which version is missing"
else
    ok "${CASE_NAME}"
fi

# ---------------------------------------------------------------------------
# 6. The self-check runs in `--dist` too, even though that mode never fetches.
#    This is what stops the guard from being invisible to the mode people
#    actually run — the exact hole that let the original bug survive.
# ---------------------------------------------------------------------------
run_case "--dist runs the URL self-check as well" "${BROKEN}" --dist "${WORK}/nonexistent-dist"
if [[ "${STATUS}" == 0 ]]; then
    bad "${CASE_NAME}" "--dist accepted a manifest with an unresolvable baseURL"
elif ! printf '%s' "${OUTPUT}" | grep -q 'placeholder survived unexpanded'; then
    bad "${CASE_NAME}" "--dist failed for some other reason than the URL check"
else
    ok "${CASE_NAME}"
fi

# ---------------------------------------------------------------------------
# 7. Regression guard: the new check must not break a legitimately unpublished
#    feature-branch run, which is the state this repo is in most of the time.
# ---------------------------------------------------------------------------
run_case "a genuinely unpublished release still warns and passes" "${GOOD}" --allow-unpublished
if expect_status 0; then
    if ! printf '%s' "${OUTPUT}" | grep -q 'is not published'; then
        bad "${CASE_NAME}" "expected the 'not published yet' warning"
    else
        ok "${CASE_NAME}"
    fi
fi

# ---------------------------------------------------------------------------
# 8. ...and without the flag, unpublished is still a hard failure.
# ---------------------------------------------------------------------------
run_case "unpublished without the flag still fails" "${GOOD}"
if [[ "${STATUS}" == 0 ]]; then
    bad "${CASE_NAME}" "an unpublished release passed without --allow-unpublished"
else
    ok "${CASE_NAME}"
fi

echo
if [[ "${FAIL}" -gt 0 ]]; then
    echo "FAIL: ${FAIL} failed, ${PASS} passed"
    exit 1
fi
echo "OK: ${PASS} passed"
