#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Single-source-of-truth version propagation for @traceitx/react.
#
# Reads `version` from package.json (the canonical source — same string npm
# publishes under) and overwrites `src/internal/version.ts` with a matching
# `PKG_VERSION` literal so envelope.sdk.version stays in lockstep with the
# published artifact.
#
# Idempotent: rerunning with no package.json change is a no-op (file is
# rewritten byte-identically; `git diff` stays clean).
#
# Invoked automatically as `prebuild` in package.json so `pnpm build` can
# never publish a stale literal. Run manually after `pnpm version <x.y.z>`
# if you want the bump committed before building.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PACKAGE_JSON="${PKG_DIR}/package.json"
VERSION_TS="${PKG_DIR}/src/internal/version.ts"

# Grep package.json's top-level "version" field. The line looks like:
#   "version": "0.1.0",
# We pin to the first match so a nested dep with its own "version" key
# (e.g. peerDependencies) never gets picked up.
VERSION="$(awk -F'"' '/^[[:space:]]*"version"[[:space:]]*:/ { print $4; exit }' "${PACKAGE_JSON}")"

if [[ -z "${VERSION}" ]]; then
    echo "error: could not parse \"version\" from ${PACKAGE_JSON}" 1>&2
    exit 1
fi

# Lightweight SemVer sanity check so a typo doesn't propagate downstream.
if ! [[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
    echo "error: '${VERSION}' is not a valid SemVer string" 1>&2
    exit 1
fi

cat > "${VERSION_TS}" <<EOF
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// AUTO-OVERWRITTEN. Edit \`package.json:version\` instead.
//
// \`scripts/sync-version.sh\` rewrites this file from package.json before every
// build (wired as \`prebuild\` in package.json) so the published bundle's
// \`envelope.sdk.version\` is always in lockstep with the npm metadata. The
// committed literal exists so tests, type-checks, and in-IDE development
// work without running the script first.
export const PKG_VERSION = '${VERSION}';
EOF

echo "[sync-version] PKG_VERSION = ${VERSION}"
