#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Guard: `Package.binary.swift`'s `binaryVersion` and every one of its
# `checksum:` values must describe the SAME set of artifacts — plus the
# CocoaPods source zip named by `Everframe.podspec`, which is a release asset
# nothing else checks.
#
# Why this exists. `scripts/sync-version.sh` propagates the podspec version
# literal into `binaryVersion`, but — by design, and contrary to what its own
# comment used to claim — it does NOT touch the checksums. So a plain version
# bump silently produces a manifest that points at `v<new>/` URLs while
# carrying the SHA256s of the PREVIOUS release's zips. SwiftPM then rejects
# every fetch with "checksum of downloaded artifact does not match", and the
# only signal before that point is a human remembering the comment at the top
# of the manifest. That exact drift shipped once already (0.5.0 manifest
# carrying verified-identical 0.4.5 hashes), which is why this is now a check
# and not a note.
#
# The CocoaPods asset is checked here rather than by a separate script because
# this is the gate PUBLISHING.md §6 makes mandatory before `pod trunk push`,
# and `pod trunk push` is exactly what a missing `Everframe-<version>.zip`
# breaks. It is not a `binaryTarget`, so the loop above cannot see it, and its
# name is DERIVED from the podspec's own `spec.source` — never retyped here.
# There is no checksum to compare: CocoaPods does not verify one, so existence
# at the right URL is the whole property.
#
# Two modes:
#
#   --dist [DIR]      Compare the manifest against locally built artifacts,
#                     reading the `.sha256` sidecars `build-xcframework.sh`
#                     writes (default DIR: packages/sdk-ios/dist). Use this
#                     BEFORE uploading, so a bad manifest never reaches a
#                     release.
#
#   (default)         Compare the manifest against the artifacts actually
#                     attached to the GitHub Release — the bytes a real
#                     consumer's SwiftPM will download and hash. Use this
#                     AFTER `gh release create`, as the last gate before
#                     `pod trunk push`.
#
# An unpublished release is a hard failure by default, because at release time
# it means the upload did not happen. On a feature branch — where the version
# is bumped long before any artifact exists — that state is legitimate; pass
# `--allow-unpublished` to downgrade it to a warning.
#
# `--ref` is what makes the RELEASE TAG safe, and it is the reason this script
# reads its manifests through a variable instead of a fixed path. The bytes a
# SwiftPM consumer resolves are the ones committed at the tag — not the ones in
# whoever's working tree ran the build. Those two diverge by default, because
# `build-xcframework.sh` REWRITES `Package.binary.swift` and nothing commits
# that rewrite for you: tag first and the tag ships the previous release's
# checksums, which is precisely the failure PUBLISHING.md used to have baked
# into its step order. Point this at the tag you are about to push and the
# question "does the tagged manifest describe the uploaded artifacts?" is
# answered mechanically instead of by reading the runbook carefully.
#
# Usage:
#   scripts/verify-binary-checksums.sh                     # fetch published
#   scripts/verify-binary-checksums.sh --dist              # local dist/
#   scripts/verify-binary-checksums.sh --dist /some/dir
#   scripts/verify-binary-checksums.sh --allow-unpublished
#   scripts/verify-binary-checksums.sh --version 0.4.5     # override manifest
#   scripts/verify-binary-checksums.sh --ref v0.5.0        # manifest AT a tag
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MANIFEST="${PKG_DIR}/Package.binary.swift"
POD_SPEC="${PKG_DIR}/Everframe.podspec"
MANIFEST_LABEL="Package.binary.swift"

MODE="fetch"
DIST_DIR="${PKG_DIR}/dist"
ALLOW_UNPUBLISHED=0
VERSION_OVERRIDE=""
GIT_REF=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dist)
            MODE="dist"
            if [[ $# -gt 1 && "$2" != --* ]]; then DIST_DIR="$2"; shift; fi
            ;;
        --allow-unpublished) ALLOW_UNPUBLISHED=1 ;;
        --version)
            [[ $# -gt 1 ]] || { echo "error: --version needs a value" 1>&2; exit 2; }
            VERSION_OVERRIDE="$2"; shift
            ;;
        --ref)
            [[ $# -gt 1 ]] || { echo "error: --ref needs a git ref" 1>&2; exit 2; }
            GIT_REF="$2"; shift
            ;;
        # Print the whole header comment: the line range is derived from where
        # `set -euo pipefail` starts the code, so growing the header can never
        # silently truncate --help the way a hand-written range does.
        -h|--help)
            head -n "$(( $(grep -n '^set -euo pipefail' "${BASH_SOURCE[0]}" | head -1 | cut -d: -f1) - 1 ))" \
                "${BASH_SOURCE[0]}" | tail -n +2
            exit 0
            ;;
        *) echo "error: unknown argument '$1'" 1>&2; exit 2 ;;
    esac
    shift
done

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

# --ref: swap BOTH manifests for the versions committed at that ref. Both, not
# just the binary manifest — the podspec supplies the CocoaPods asset name and
# the version-drift check, so reading a tagged manifest against the working
# tree's podspec would compare two different releases.
#
# The in-repo path is asked of git rather than written out here, for the same
# reason the CocoaPods asset name is parsed out of the podspec: a second
# hand-kept copy of a path is a thing that goes stale.
if [[ -n "${GIT_REF}" ]]; then
    command -v git >/dev/null 2>&1 || { echo "error: --ref needs git in PATH" 1>&2; exit 2; }
    REF_DIR="${TMP_DIR}/ref"
    mkdir -p "${REF_DIR}"
    PREFIX="$(git -C "${PKG_DIR}" rev-parse --show-prefix 2>/dev/null)" || {
        echo "error: --ref only works inside a git checkout" 1>&2; exit 2; }
    for f in Package.binary.swift Everframe.podspec; do
        if ! git -C "${PKG_DIR}" show "${GIT_REF}:${PREFIX}${f}" > "${REF_DIR}/${f}" 2>"${TMP_DIR}/git-err"; then
            echo "error: could not read ${PREFIX}${f} at ref '${GIT_REF}':" 1>&2
            cat "${TMP_DIR}/git-err" 1>&2
            exit 2
        fi
    done
    MANIFEST="${REF_DIR}/Package.binary.swift"
    POD_SPEC="${REF_DIR}/Everframe.podspec"
    MANIFEST_LABEL="${GIT_REF}:${PREFIX}Package.binary.swift"
fi

[[ -f "${MANIFEST}" ]] || { echo "error: ${MANIFEST} not found" 1>&2; exit 2; }

VERSION="$(awk -F'"' '/^let binaryVersion =/ { print $2; exit }' "${MANIFEST}")"
[[ -n "${VERSION}" ]] || { echo "error: could not parse binaryVersion from ${MANIFEST}" 1>&2; exit 2; }

# The URL template lives in the manifest too, so a repo move can't leave this
# guard checking a stale host while consumers fetch from the new one.
BASE_URL_TEMPLATE="$(awk -F'"' '/^let baseURL =/ { print $2; exit }' "${MANIFEST}")"
[[ -n "${BASE_URL_TEMPLATE}" ]] || { echo "error: could not parse baseURL from ${MANIFEST}" 1>&2; exit 2; }

EFFECTIVE_VERSION="${VERSION_OVERRIDE:-${VERSION}}"

# The search pattern is SINGLE-QUOTED, and that is the whole point of this line.
# What the manifest holds is Swift string interpolation — `v\(binaryVersion)/` —
# so the template string contains a literal backslash AND literal parentheses,
# every one of which is a pattern metacharacter in some shell. Written unquoted
# (`${T//\\(binaryVersion)/…}`) this is correct under bash but a SILENT NO-OP
# under zsh, where `( … )` is a pattern group: the pattern degrades to
# `\binaryVersion`, matches nothing, and BASE_URL keeps the placeholder verbatim
# with no error anywhere. Quoting makes all three characters literal in either
# dialect, so the line cannot mean two different things depending on who reads
# it. Do not "tidy" the quotes away.
BASE_URL="${BASE_URL_TEMPLATE//'\(binaryVersion)'/${EFFECTIVE_VERSION}}"

# Self-check, and it runs in EVERY mode — including `--dist`, which never
# touches BASE_URL. That is deliberate. The substitution above had never been
# exercised by anything: `--dist` is the mode people actually run, and it skips
# the fetch entirely, so a broken expansion could sit here indefinitely while
# every local run went green. A guard that only fires in the rarely-run mode is
# the same defect one level up. Checking unconditionally means the common
# invocation proves the URL construction too.
#
# It is a HARD failure, before the first request, and it deliberately ignores
# `--allow-unpublished`. A malformed URL 404s in exactly the same way a
# not-yet-published release does, so without this check `--allow-unpublished`
# would convert a broken template into a cheerful "expected on a feature
# branch" warning and exit 0 — turning the release gate into a rubber stamp.
#
# The assertion is on the RESULT, not on the substitution, so it survives the
# things that actually go wrong: `binaryVersion` renamed in the manifest, a
# different interpolation spelling, or a shell whose pattern rules differ. Any
# of those leave either a placeholder fragment or a URL with no version in it.
url_problem=""
# shellcheck disable=SC2016  # `$(` and `${` are the literals being searched for.
case "${BASE_URL}" in
    *'\('*|*'$('*|*'${'*|*binaryVersion*)
        url_problem="a version placeholder survived unexpanded" ;;
    *"${EFFECTIVE_VERSION}"*) ;;
    *)
        url_problem="it does not mention version ${EFFECTIVE_VERSION} anywhere" ;;
esac
if [[ -n "${url_problem}" ]]; then
    cat 1>&2 <<EOF
error: could not build a download URL from ${MANIFEST_LABEL} — ${url_problem}.
       baseURL template: ${BASE_URL_TEMPLATE}
       expanded:         ${BASE_URL}
       effective version: ${EFFECTIVE_VERSION}

       Every fetch this run would make goes to that URL, and a bad URL 404s
       exactly like an unpublished release — so proceeding would either fail
       for the wrong reason or, with --allow-unpublished, PASS for the wrong
       reason. Reconcile the substitution in this script with the baseURL
       spelling in the manifest before rerunning.
EOF
    exit 2
fi

# name <TAB> zip-filename <TAB> checksum, one line per .binaryTarget.
parse_targets() {
    awk '
        /\.binaryTarget\(/ { inblk = 1; name = ""; zip = ""; sum = ""; next }
        inblk && /name:/     { if (match($0, /"[^"]+"/)) name = substr($0, RSTART + 1, RLENGTH - 2) }
        inblk && /url:/      { if (match($0, /"[^"]+"/)) zip  = substr($0, RSTART + 1, RLENGTH - 2) }
        inblk && /checksum:/ {
            if (match($0, /"[^"]+"/)) sum = substr($0, RSTART + 1, RLENGTH - 2)
            if (name != "" && zip != "" && sum != "") print name "\t" zip "\t" sum
            inblk = 0
        }
    ' "${MANIFEST}"
}

TARGETS="$(parse_targets)"
TARGET_COUNT="$(printf '%s\n' "${TARGETS}" | grep -c . || true)"
if [[ "${TARGET_COUNT}" -eq 0 ]]; then
    echo "error: parsed 0 binaryTargets out of ${MANIFEST} — parser and manifest have diverged" 1>&2
    exit 2
fi

echo "==> manifest:        ${MANIFEST_LABEL}"
echo "==> binaryVersion:   ${VERSION}"
[[ -n "${VERSION_OVERRIDE}" ]] && echo "==> version override: ${EFFECTIVE_VERSION}"
echo "==> mode:            ${MODE}"
[[ "${MODE}" == "dist" ]] && echo "==> dist dir:        ${DIST_DIR}"
echo

# TMP_DIR + its trap are set once, up with the argument parsing — `--ref`
# extracts the tagged manifests into it before this point, so re-creating it
# here would orphan those files and leak the first directory.
MISMATCH=0
UNPUBLISHED=0
MISSING_LOCAL=0

while IFS=$'\t' read -r name zip expected; do
    [[ -n "${name}" ]] || continue

    if [[ "${MODE}" == "dist" ]]; then
        sidecar="${DIST_DIR}/${zip}.sha256"
        if [[ ! -f "${sidecar}" ]]; then
            echo "  MISSING  ${name}: no ${sidecar}"
            MISSING_LOCAL=1
            continue
        fi
        actual="$(tr -d '[:space:]' < "${sidecar}")"
    else
        url="${BASE_URL}${zip}"
        out="${TMP_DIR}/${zip}"
        code="$(curl -sSL --retry 2 --retry-delay 1 -w '%{http_code}' -o "${out}" "${url}" 2>/dev/null || echo 000)"
        if [[ "${code}" == "404" ]]; then
            echo "  UNPUBLISHED  ${name}: ${url} → HTTP 404"
            UNPUBLISHED=1
            continue
        fi
        if [[ "${code}" != "200" ]]; then
            echo "  FETCH-ERROR  ${name}: ${url} → HTTP ${code}" 1>&2
            MISMATCH=1
            continue
        fi
        actual="$(shasum -a 256 "${out}" | awk '{print $1}')"
    fi

    if [[ "${actual}" == "${expected}" ]]; then
        echo "  OK       ${name}  ${expected}"
    else
        echo "  MISMATCH ${name}"
        echo "             manifest: ${expected}"
        echo "             artifact: ${actual}"
        MISMATCH=1
    fi
done <<< "${TARGETS}"

echo

if [[ "${MISSING_LOCAL}" -eq 1 ]]; then
    cat 1>&2 <<EOF
FAIL: one or more artifacts are missing from ${DIST_DIR}.
      Run scripts/build-xcframework.sh first — it writes each
      <Product>.xcframework.zip.sha256 sidecar this mode reads.
EOF
    exit 1
fi

if [[ "${UNPUBLISHED}" -eq 1 ]]; then
    if [[ "${ALLOW_UNPUBLISHED}" -eq 1 ]]; then
        cat <<EOF
WARNING: release v${EFFECTIVE_VERSION} is not published on the releases repo yet,
         so the manifest's checksums could not be verified against real
         artifacts. This is expected on a feature branch that has bumped the
         version ahead of the release. It is NOT acceptable at release time —
         rerun without --allow-unpublished once the artifacts are uploaded.
EOF
        exit 0
    fi
    cat 1>&2 <<EOF
FAIL: release v${EFFECTIVE_VERSION} is not published — the artifacts named by
      Package.binary.swift do not exist at ${BASE_URL}

      If you are mid-release: create the GitHub Release and upload
      dist/*.xcframework.zip first (PUBLISHING.md §6), then rerun.
      If you are on a feature branch that bumped the version ahead of the
      release, this state is expected — rerun with --allow-unpublished.
EOF
    exit 1
fi

if [[ "${MISMATCH}" -eq 1 ]]; then
    cat 1>&2 <<EOF
FAIL: Package.binary.swift's checksums do not match the v${EFFECTIVE_VERSION} artifacts.
      SwiftPM will reject every consumer fetch with
      "checksum of downloaded artifact does not match".

      Do NOT hand-edit a guess. Either
        * rerun scripts/build-xcframework.sh (it rewrites the checksums from
          the zips it just built), or
        * copy the values this run printed under "artifact:" — they are the
          SHA256s of the bytes actually served.
EOF
    exit 1
fi


# ---------------------------------------------------------------------------
# CocoaPods source zip. Derived from the podspec, not restated.
# ---------------------------------------------------------------------------

# POD_SPEC was resolved with the argument parsing — working tree by default,
# the tagged copy under `--ref`. Do NOT re-derive it from PKG_DIR here: that
# silently un-does `--ref` for this whole section, so a tagged manifest would be
# drift-checked and asset-named against whatever the working tree happens to
# say. (It did exactly that for one revision of this change.)
[[ -f "${POD_SPEC}" ]] || { echo "error: ${POD_SPEC} not found" 1>&2; exit 2; }

POD_VERSION="$(awk -F'"' '/^ *spec.version/ { print $2; exit }' "${POD_SPEC}")"
[[ -n "${POD_VERSION}" ]] || { echo "error: could not parse spec.version from ${POD_SPEC}" 1>&2; exit 2; }

# The `:http =>` line, with the Ruby interpolation resolved. Parsing the URL
# rather than assuming the filename means a rename of the archive is picked up
# here automatically.
# EFFECTIVE_VERSION, not POD_VERSION: with `--version` the whole run is aimed
# at a different release, and the CocoaPods asset for that release is named
# after it too. They are equal in the ordinary case, which the drift check
# below enforces.
POD_ASSET="$(awk -F'"' '/:http *=>/ { print $2; exit }' "${POD_SPEC}" \
    | sed "s/#{spec.version}/${EFFECTIVE_VERSION}/g")"
POD_ASSET="${POD_ASSET##*/}"
[[ -n "${POD_ASSET}" ]] || { echo "error: could not parse spec.source :http from ${POD_SPEC}" 1>&2; exit 2; }

# One release, one version. sync-version.sh drives binaryVersion FROM the
# podspec, so a disagreement means someone edited one by hand.
if [[ -z "${VERSION_OVERRIDE}" && "${POD_VERSION}" != "${VERSION}" ]]; then
    cat 1>&2 <<EOF
FAIL: version drift between the two iOS manifests.
      Everframe.podspec   spec.version  = ${POD_VERSION}
      Package.binary.swift binaryVersion = ${VERSION}
      The podspec is the source of truth — rerun scripts/sync-version.sh.
EOF
    exit 1
fi

if [[ "${MODE}" == "dist" ]]; then
    if [[ ! -f "${DIST_DIR}/${POD_ASSET}" ]]; then
        echo "  MISSING  CocoaPods zip: no ${DIST_DIR}/${POD_ASSET}" 1>&2
        cat 1>&2 <<EOF
FAIL: the CocoaPods source zip is missing from ${DIST_DIR}.
      Run scripts/build-xcframework.sh — it writes Everframe-<version>.zip
      alongside the xcframework zips.
EOF
        exit 1
    fi
    echo "  OK       CocoaPods zip  ${POD_ASSET}"
else
    pod_code="$(curl -sSL --retry 2 --retry-delay 1 -o /dev/null -w '%{http_code}' "${BASE_URL}${POD_ASSET}" 2>/dev/null || echo 000)"
    if [[ "${pod_code}" == "404" ]]; then
        if [[ "${ALLOW_UNPUBLISHED}" -eq 1 ]]; then
            echo "WARNING: CocoaPods zip ${POD_ASSET} is not published yet (HTTP 404)."
            exit 0
        fi
        cat 1>&2 <<EOF
FAIL: ${BASE_URL}${POD_ASSET} → HTTP 404.
      The GitHub Release is missing the CocoaPods source zip, so
      \`pod trunk push\` will fail its lint. Upload it (PUBLISHING.md §6
      uploads dist/*.xcframework.zip AND dist/Everframe-<version>.zip), then
      rerun.
EOF
        exit 1
    fi
    if [[ "${pod_code}" != "200" ]]; then
        echo "FETCH-ERROR  CocoaPods zip: ${BASE_URL}${POD_ASSET} → HTTP ${pod_code}" 1>&2
        exit 1
    fi
    echo "  OK       CocoaPods zip  ${POD_ASSET}"
fi

echo "OK: all ${TARGET_COUNT} checksums in Package.binary.swift match the v${EFFECTIVE_VERSION} artifacts."
echo "OK: the CocoaPods source zip ${POD_ASSET} is present."

