#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX

set -euo pipefail

VERSION="${1:-0.0.0-ci}"
MAVEN_REPOSITORY="${MAVEN_LOCAL_REPOSITORY:-${HOME}/.m2/repository}"

verify_artifact() {
    local artifact="$1"
    local directory="${MAVEN_REPOSITORY}/com/traceitx/${artifact}/${VERSION}"
    local sources="${directory}/${artifact}-${VERSION}-sources.jar"
    local javadoc="${directory}/${artifact}-${VERSION}-javadoc.jar"
    local source_entries
    local javadoc_entries

    [[ -f "${sources}" ]] || { echo "missing ${sources}" >&2; return 1; }
    [[ -f "${javadoc}" ]] || { echo "missing ${javadoc}" >&2; return 1; }

    source_entries="$(unzip -Z1 "${sources}")"
    javadoc_entries="$(unzip -Z1 "${javadoc}")"
    grep -Eq '\.(kt|java)$' <<<"${source_entries}" || {
        echo "${sources} contains no source files" >&2
        return 1
    }
    grep -Eq '\.html$' <<<"${javadoc_entries}" || {
        echo "${javadoc} contains no generated API documentation" >&2
        return 1
    }
}

for artifact in core media3 protocol reporter-ui traceitx-gradle-plugin; do
    verify_artifact "${artifact}"
done

echo "Android publication contains real sources and API documentation for all modules."
