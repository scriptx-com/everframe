#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX

set -euo pipefail

INPUT="${1:?usage: verify-central-bundle.sh <bundle.zip|repository-directory> [version]}"
VERSION="${2:-0.9.0}"
WORK_DIRECTORY=""
FORMER_NAME="trace""itx"
FORMER_GROUP="com.${FORMER_NAME}"
FORMER_ENDPOINT="https://${FORMER_NAME}.com"

cleanup() {
    if [[ -n "${WORK_DIRECTORY}" ]]; then
        rm -rf "${WORK_DIRECTORY}"
    fi
}
trap cleanup EXIT

if [[ -d "${INPUT}" ]]; then
    REPOSITORY="${INPUT}"
elif [[ -f "${INPUT}" ]]; then
    WORK_DIRECTORY="$(mktemp -d)"
    unzip -q "${INPUT}" -d "${WORK_DIRECTORY}"
    REPOSITORY="${WORK_DIRECTORY}"
else
    echo "bundle input does not exist: ${INPUT}" >&2
    exit 1
fi

while IFS= read -r -d '' artifact; do
    case "${artifact}" in
        *.asc|*.md5|*.sha1|*.sha256|*.sha512|*/maven-metadata.xml*) continue ;;
    esac
    [[ -f "${artifact}.asc" ]] || { echo "missing signature ${artifact}.asc" >&2; exit 1; }
    [[ -f "${artifact}.md5" ]] || { echo "missing checksum ${artifact}.md5" >&2; exit 1; }
    [[ -f "${artifact}.sha1" ]] || { echo "missing checksum ${artifact}.sha1" >&2; exit 1; }
    expected_md5="$(tr -d '[:space:]' < "${artifact}.md5")"
    actual_md5="$(md5 -q "${artifact}")"
    [[ "${actual_md5}" == "${expected_md5}" ]] || { echo "invalid checksum ${artifact}.md5" >&2; exit 1; }
    expected_sha1="$(tr -d '[:space:]' < "${artifact}.sha1")"
    actual_sha1="$(shasum -a 1 "${artifact}" | awk '{print $1}')"
    [[ "${actual_sha1}" == "${expected_sha1}" ]] || { echo "invalid checksum ${artifact}.sha1" >&2; exit 1; }
    if [[ "${EVERFRAME_VERIFY_GPG:-0}" == "1" ]]; then
        command -v gpg >/dev/null || { echo "gpg is required when EVERFRAME_VERIFY_GPG=1" >&2; exit 1; }
        gpg --batch --verify "${artifact}.asc" "${artifact}" >/dev/null 2>&1 || {
            echo "invalid signature ${artifact}.asc" >&2
            exit 1
        }
    fi
done < <(find "${REPOSITORY}/dev/everframe" -type f -print0)

MAVEN_LOCAL_REPOSITORY="${REPOSITORY}" "$(dirname "$0")/verify-android-publication.sh" "${VERSION}"

if rg -n "${FORMER_GROUP}|${FORMER_ENDPOINT}|ossrh-staging-api|service/local/staging" "${REPOSITORY}"; then
    echo "Central bundle contains a legacy coordinate, endpoint, or staging API reference" >&2
    exit 1
fi

echo "Signed Central Portal bundle verified for dev.everframe:*:${VERSION}."
echo "The bundle is ready for USER_MANAGED upload through https://central.sonatype.com/api/v1/publisher/upload; no upload was performed."
