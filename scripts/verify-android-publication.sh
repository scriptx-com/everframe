#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX

set -euo pipefail

VERSION="${1:-0.9.0}"
MAVEN_REPOSITORY="${MAVEN_LOCAL_REPOSITORY:-${HOME}/.m2/repository}"
GROUP_DIRECTORY="${MAVEN_REPOSITORY}/dev/everframe"
FORMER_NAME="trace""itx"
FORMER_GROUP="com.${FORMER_NAME}"
FORMER_ENDPOINT="https://${FORMER_NAME}.com"

fail() {
    echo "$*" >&2
    exit 1
}

verify_artifact() {
    local artifact="$1"
    local packaging="$2"
    local directory="${GROUP_DIRECTORY}/${artifact}/${VERSION}"
    local prefix="${directory}/${artifact}-${VERSION}"
    local primary="${prefix}.${packaging}"
    local pom="${prefix}.pom"
    local sources="${directory}/${artifact}-${VERSION}-sources.jar"
    local javadoc="${directory}/${artifact}-${VERSION}-javadoc.jar"

    [[ -f "${primary}" ]] || fail "missing ${primary}"
    [[ -f "${pom}" ]] || fail "missing ${pom}"
    [[ -f "${sources}" ]] || fail "missing ${sources}"
    [[ -f "${javadoc}" ]] || fail "missing ${javadoc}"

    grep -q '<groupId>dev.everframe</groupId>' "${pom}" || fail "${pom} does not use dev.everframe"
    if grep -Fq "${FORMER_GROUP}" "${pom}"; then
        fail "${pom} contains former Maven coordinates"
    fi
    # Do not use grep -q here: with pipefail it can close the pipe early and
    # turn unzip's otherwise-successful listing into a SIGPIPE failure.
    unzip -Z1 "${sources}" | grep -E '\.(kt|java)$' >/dev/null || fail "${sources} contains no source files"
    unzip -Z1 "${javadoc}" | grep -E '\.html$' >/dev/null || fail "${javadoc} contains no generated API documentation"
}

[[ -d "${GROUP_DIRECTORY}" ]] || fail "missing canonical Maven group ${GROUP_DIRECTORY}"
[[ ! -e "${MAVEN_REPOSITORY}/${FORMER_GROUP//.//}" ]] || fail "former Maven group is present"

verify_artifact protocol aar
verify_artifact core aar
verify_artifact reporter-ui aar
verify_artifact media3 aar
verify_artifact everframe-gradle-plugin jar

CORE_AAR="${GROUP_DIRECTORY}/core/${VERSION}/core-${VERSION}.aar"
CORE_CLASSES="$(mktemp)"
trap 'rm -f "${CORE_CLASSES}"' EXIT
unzip -p "${CORE_AAR}" classes.jar >"${CORE_CLASSES}"
if unzip -t "${CORE_CLASSES}" >/dev/null 2>&1; then
    CORE_STRINGS="$(unzip -p "${CORE_CLASSES}" | strings)"
else
    # Kept for the intentionally-minimal verifier fixtures.
    CORE_STRINGS="$(strings "${CORE_CLASSES}")"
fi
grep -q 'https://everframe.dev' <<<"${CORE_STRINGS}" || fail "${CORE_AAR} does not contain the Everframe release endpoint"
if grep -Fq "${FORMER_ENDPOINT}" <<<"${CORE_STRINGS}"; then
    fail "${CORE_AAR} contains the former endpoint"
fi

echo "Android publication verified at dev.everframe:*:${VERSION}."
