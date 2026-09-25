#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
#
# Build EverframeProtocol.xcframework + EverframeKit.xcframework +
# EverframeReporterUI.xcframework for iOS device, iOS simulator, tvOS device,
# tvOS simulator. Output under `dist/` is THREE zipped xcframeworks plus their
# SHA256 sidecars, AND the combined `Everframe-<version>.zip` (+ sidecar) that
# Everframe.podspec's single `spec.source` fetches — four release assets in
# total. PUBLISHING.md §6 uploads `dist/*.xcframework.zip` plus that combined
# zip by glob rather than by name for exactly that reason; an earlier revision
# of this comment said "two xcframeworks", named a `Everframe.xcframework` that
# has never existed, and is the most likely origin of the hand-written
# two-asset upload list that shipped a release SwiftPM could not resolve.
#
# The three-product list below is repeated in a few loops rather than derived.
# That is guarded, not unguarded: `sync_binary_checksums` ends by running
# `verify-binary-checksums.sh --dist`, which parses the `binaryTarget`s out of
# Package.binary.swift and fails `MISSING` for any declared product this script
# did not build. Add a product to the manifest without adding it here and the
# build stops.
#
# Why two-step (xcodegen + xcodebuild): SwiftPM library targets don't archive
# into `.framework` bundles — xcodebuild produces static `.o` files at
# `Products/Users/.../Objects/`, which xcodebuild -create-xcframework can't
# consume in `-framework` mode. The fix is a thin wrapper Xcode project with
# proper framework targets that compile the same Sources/* directories. We
# generate that project from `project.yml` via XcodeGen so we don't hand-
# maintain .pbxproj.
#
# Requirements:
#   * xcodegen (`brew install xcodegen`)
#   * Xcode 26.5+ with iOS + tvOS SDKs
#
# Source files are NOT distributed. Consumers see only the public Swift
# module interface (.swiftinterface) — the compiler ABI contract — and the
# compiled binary. Identifier obfuscation beyond non-public-symbol stripping
# is not available for Swift; the binary distribution itself is the obfuscation.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_DIR="$(cd "${PKG_DIR}/../.." && pwd)"
DIST_DIR="${PKG_DIR}/dist"
ARCHIVE_DIR="${DIST_DIR}/archives"
PROJECT="${PKG_DIR}/Everframe.xcodeproj"

# A DerivedData root this script OWNS, passed to every `xcodebuild archive`
# below. Without it the archives land in Xcode's shared DerivedData, where
# `patch_swiftinterface_into_framework` has to go looking for their
# intermediates among every other Everframe build tree on the machine — the
# checkout's own IDE builds, other worktrees, and last release's leftovers.
# That search is how v0.6.6 shipped a tvOS-simulator slice whose
# .swiftinterface predated the branding API (ReporterThemeOptions et al):
# right product, right arch, right sdk, months-old contents. See the
# uniqueness assertion in that function for the other half of the fix.
#
# Deliberately NOT wiped per run, and not per-(scheme, sdk): a stable path
# is what keeps xcodebuild's incremental rebuild working across releases.
# Freshness is not what makes the copy correct — reading the archive's own
# scheme-scoped intermediates is.
DERIVED_DATA="${EVERFRAME_XCFRAMEWORK_DERIVED_DATA:-${HOME}/Library/Developer/Xcode/DerivedData/Everframe-xcframework}"

# Build configuration. Release (the default) is what ships: it compiles out
# the `#if DEBUG` dev-ingest-URL override in IngestEndpoint.swift, so the
# binary is hardwired to production. Dev runners (scripts/dev/rn.mjs) set
# EVERFRAME_XCFRAMEWORK_CONFIGURATION=Debug so the vendored xcframework keeps
# the EVERFRAME_DEV_INGEST_URL runtime override and local example apps can
# submit to local ingest. NEVER publish a Debug artifact — the release
# workflow leaves this unset.
CONFIGURATION="${EVERFRAME_XCFRAMEWORK_CONFIGURATION:-Release}"
case "${CONFIGURATION}" in
    Release|Debug) ;;
    *)
        echo "error: EVERFRAME_XCFRAMEWORK_CONFIGURATION must be Release or Debug (got '${CONFIGURATION}')" 1>&2
        exit 1
        ;;
esac

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: '$1' not found in PATH. ${2:-}" 1>&2
        exit 1
    }
}

require_cmd xcodegen "Install via 'brew install xcodegen'."
require_cmd xcodebuild "Install Xcode + command-line tools."

cd "${PKG_DIR}"

# Propagate `Everframe.podspec`'s `spec.version` to Generated/SDKVersion.swift
# and Package.binary.swift before anything compiles. Idempotent — no-op if
# the source files already match the podspec.
echo "==> sync version from Everframe.podspec"
"${SCRIPT_DIR}/sync-version.sh"

# The SDK version doubles as MARKETING_VERSION for every framework target.
# project.yml sets GENERATE_INFOPLIST_FILE=YES, and the synthesized Info.plist
# only contains CFBundleShortVersionString when MARKETING_VERSION is set —
# without it, App Store validation rejects any app embedding the framework
# (ITMS error 90057, "missing plist key CFBundleShortVersionString").
# The podspec is the SOLE source, and `EVERFRAME_VERSION` is an assertion about
# it — not an override. It used to be documented as "env wins", which was never
# true and was actively harmful: `sync-version.sh` has already rewritten
# `binaryVersion` and `Generated/SDKVersion.swift` from the podspec by this
# point, so an env value that disagreed produced one build carrying THREE
# versions — zips and MARKETING_VERSION named after the env, the SwiftPM
# manifest's `v<version>/` URLs after the podspec, and the release tag after
# whatever the human typed. It also broke the CocoaPods-zip presence check at
# the end of `sync_binary_checksums` for a reason that had nothing to do with
# the checksums: that check derives the asset name from the podspec, so it went
# looking for a zip this script had named after the env var. Nothing in the repo
# sets `EVERFRAME_VERSION`; keeping it as an equality assertion means a caller
# who does set it gets told, rather than shipping the split-brain build.
SDK_VERSION="$(awk -F'"' '/^[[:space:]]*spec\.version[[:space:]]*=/ { print $2; exit }' "${PKG_DIR}/Everframe.podspec")"
if [[ -z "${SDK_VERSION}" ]]; then
    echo "error: could not determine SDK version for MARKETING_VERSION" 1>&2
    exit 1
fi
if [[ -n "${EVERFRAME_VERSION:-}" && "${EVERFRAME_VERSION}" != "${SDK_VERSION}" ]]; then
    echo "error: EVERFRAME_VERSION='${EVERFRAME_VERSION}' disagrees with Everframe.podspec spec.version='${SDK_VERSION}'." 1>&2
    echo "       The podspec is the single source of truth (scripts/sync-version.sh drives" 1>&2
    echo "       Package.binary.swift and Generated/SDKVersion.swift from it). Bump the" 1>&2
    echo "       podspec instead of overriding the environment." 1>&2
    exit 1
fi
echo "==> SDK version ${SDK_VERSION}"
echo "==> configuration ${CONFIGURATION}"

# Swift `package`-level access (used by `CompanionAPI.__builtinPinUiInstalled`
# / `__builtinPinUiSuppressed`, spec 2026-08-19) requires every module that
# shares it to compile under the SAME `-package-name`. Under `swift build`,
# SwiftPM derives and passes this automatically from `Package.swift`'s
# `Package(name:)` — which is exactly why `swift build`/`swift test` never hit
# this, and only the manual `xcodebuild archive` path below does. Read it from
# `Package.swift` rather than hardcoding it here so the two can never drift:
# the FIRST `name: "..."` line in the file is the `Package(name:)` argument —
# every other `name:` in the manifest (products, targets, test targets) comes
# later.
SWIFT_PACKAGE_NAME="$(awk -F'"' '/^[[:space:]]*name:[[:space:]]*"/ { print $2; exit }' "${PKG_DIR}/Package.swift")"
if [[ -z "${SWIFT_PACKAGE_NAME}" ]]; then
    echo "error: could not determine the Swift package name from Package.swift (Package(name:))" 1>&2
    exit 1
fi
echo "==> swift package name ${SWIFT_PACKAGE_NAME} (-package-name)"

# Declared here, next to the version it is named after, rather than at the
# point of use near the bottom: `sync_binary_checksums` asserts on it, and
# under `set -u` a definition that lives below its first reader is a second
# ordering bug waiting behind the first one.
COMBINED_VERSION="${SDK_VERSION}"
COMBINED_ZIP="${DIST_DIR}/Everframe-${COMBINED_VERSION}.zip"

echo "==> regenerate ${PROJECT}"
rm -rf "${PROJECT}"
xcodegen generate --quiet

echo "==> clean ${DIST_DIR}"
rm -rf "${DIST_DIR}"
mkdir -p "${ARCHIVE_DIR}"

# `xcodebuild archive` produces an .xcarchive with the .framework bundle at
#   <archive>/Products/Library/Frameworks/<scheme>.framework
# when the project target is type=framework + SKIP_INSTALL=NO. Both are set
# in project.yml.
#
# `OTHER_SWIFT_FLAGS="$(inherited) -package-name ${SWIFT_PACKAGE_NAME}"` below
# is a command-line override layered onto project.yml's own OTHER_SWIFT_FLAGS
# via `$(inherited)` — same composition project.yml itself uses to layer onto
# Xcode's defaults. Without it, `xcodebuild archive` fails every target that
# uses Swift `package`-level access (e.g. `CompanionAPI.__builtinPinUiInstalled`,
# spec 2026-08-19) with "the package access level ... requires a package name";
# `swift build`/`swift test` never hit this because SwiftPM infers and passes
# `-package-name` itself from `Package.swift`'s `Package(name:)` — this script
# is the one caller that goes around SwiftPM entirely.
archive() {
    local scheme="$1"
    local sdk="$2"
    local destination="$3"
    local archive_path="$4"

    echo "==> archive ${scheme} (${sdk})"
    xcodebuild archive \
        -project "${PROJECT}" \
        -scheme "${scheme}" \
        -destination "${destination}" \
        -archivePath "${archive_path}" \
        -derivedDataPath "${DERIVED_DATA}" \
        -sdk "${sdk}" \
        -configuration "${CONFIGURATION}" \
        SKIP_INSTALL=NO \
        BUILD_LIBRARIES_FOR_DISTRIBUTION=YES \
        ONLY_ACTIVE_ARCH=NO \
        MARKETING_VERSION="${SDK_VERSION}" \
        CURRENT_PROJECT_VERSION=1 \
        OTHER_SWIFT_FLAGS="\$(inherited) -package-name ${SWIFT_PACKAGE_NAME}" \
        | grep -E "^\*\*|error:" || true

    patch_swiftinterface_into_framework "${scheme}" "${archive_path}" "${sdk}"
}

# Xcode 26.5 + the XcodeGen-generated project skip the "copy .swiftinterface
# into framework/Modules/Module.swiftmodule/" step that BUILD_LIBRARIES_FOR_
# DISTRIBUTION normally performs. The compiler still EMITS the interfaces
# into the build-intermediate directory (forced by OTHER_SWIFT_FLAGS in
# project.yml); this helper copies them across so create-xcframework can
# find them.
patch_swiftinterface_into_framework() {
    local product_name="$1"
    local archive_path="$2"
    local sdk="$3"
    local framework="${archive_path}/Products/Library/Frameworks/${product_name}.framework"
    local modules="${framework}/Modules/${product_name}.swiftmodule"

    if [[ ! -d "${modules}" ]]; then
        echo "    skip swiftinterface patch — ${modules} missing"
        return
    fi

    # Xcode lays archive intermediates out as
    #   <DerivedData>/Build/Intermediates.noindex/ArchiveIntermediates/
    #     <scheme>/IntermediateBuildFilesPath/Everframe.build/
    #     <Configuration>-<sdk>/<product>.build/Objects-normal/<arch>/
    #     <product>.swiftinterface
    #
    # THREE filters, and every one of them has shipped a broken release when
    # it was missing:
    #
    #   * `<Configuration>-<sdk>` — all four SDKs share the Everframe.build
    #     prefix (the archive_path name carries no sdk token), so without it
    #     the find picks a leftover from a previous archive and ships a
    #     tvOS-target interface inside the iOS-simulator slice. Consumers get
    #     "no type named 'UITree' in module 'EverframeProtocol'" on import.
    #     Shipped v0.1.1, corrected v0.1.2. It tracks CONFIGURATION for the
    #     same reason — a Debug build must not scavenge Release intermediates.
    #
    #   * `ArchiveIntermediates/<product>` — a scheme's DEPENDENCIES get their
    #     own <dep>.build tree under the DEPENDENT's archive, so for
    #     (product=EverframeKit, sdk=appletvsimulator) there are at least two
    #     matching dirs: EverframeKit's own archive, and the copy rebuilt under
    #     ArchiveIntermediates/EverframeReporterUI. The outer loop archives
    #     EverframeKit BEFORE EverframeReporterUI, so at that moment the nested
    #     copy still holds the PREVIOUS RELEASE's output. Right product, right
    #     arch, right sdk, stale contents — and since `archive()` always calls
    #     us with product_name == scheme, the scheme's own subtree is the only
    #     correct answer. This is what shipped v0.6.6's tvOS-simulator slice
    #     missing ReporterThemeOptions / ReporterTheme / ThemeResolver /
    #     BrandingConfigWire / BrandingThemeWire, while the binary, .swiftdoc
    #     and .abi.json in the same slice had them.
    #
    #   * DERIVED_DATA as the search root — the old root was ALL of
    #     ~/Library/Developer/Xcode/DerivedData with a `*Everframe-*` path
    #     match, which also swept in IDE builds and sibling worktrees.
    #
    # And `head -1` is gone. It is what turned each of the above from a build
    # failure into a silently mis-assembled artifact: with the filters right
    # there is exactly ONE answer, so anything else means the layout moved
    # under us and the only safe response is to stop.
    local sdk_filter="*${CONFIGURATION}-${sdk}/*"
    local scheme_filter="*/ArchiveIntermediates/${product_name}/*"

    local matches
    matches="$(find "${DERIVED_DATA}" \
                    -type d -name "${product_name}.build" \
                    -path "${sdk_filter}" \
                    -path "${scheme_filter}" \
                    2>/dev/null)"
    if [[ -z "${matches}" ]]; then
        echo "    skip swiftinterface patch — no ${product_name}.build for sdk=${sdk}"
        return
    fi
    if [[ "$(printf '%s\n' "${matches}" | wc -l | tr -d ' ')" != "1" ]]; then
        echo "error: ${product_name}/${sdk}: expected exactly one intermediates dir, found:" 1>&2
        printf '  %s\n' ${matches} 1>&2
        echo "       Xcode's DerivedData layout changed; picking one would ship a" 1>&2
        echo "       mismatched .swiftinterface. Fix the filters above." 1>&2
        exit 1
    fi

    local di="${matches}"

    # Each arch slice has its own .swiftinterface in Objects-normal/<arch>/.
    # The framework's Modules/<name>.swiftmodule already has <arch>.swiftmodule
    # — copy alongside it.
    while IFS= read -r src; do
        local arch
        arch="$(basename "$(dirname "${src}")")"
        local dest="${modules}/${arch}.swiftinterface"
        cp "${src}" "${dest}"
        # Also copy the .private.swiftinterface if it exists — required by
        # consumers compiling against the framework with @_spi.
        local priv_src
        priv_src="$(dirname "${src}")/${product_name}.private.swiftinterface"
        if [[ -f "${priv_src}" ]]; then
            cp "${priv_src}" "${modules}/${arch}.private.swiftinterface"
        fi
    done < <(find "${di}" -name "${product_name}.swiftinterface" -path "*Objects-normal/*" 2>/dev/null)
}

# Bundle archived .frameworks into one xcframework per product. No dSYMs are
# attached — releasing them would let any consumer line-number-map our
# crashes back to source. The `--debug-symbols` flag is intentionally omitted.
create_xcframework() {
    local product_name="$1"
    local out_path="${DIST_DIR}/${product_name}.xcframework"

    echo "==> create-xcframework ${product_name}"
    rm -rf "${out_path}"

    xcodebuild -create-xcframework \
        -framework "${ARCHIVE_DIR}/${product_name}-iphoneos.xcarchive/Products/Library/Frameworks/${product_name}.framework" \
        -framework "${ARCHIVE_DIR}/${product_name}-iphonesimulator.xcarchive/Products/Library/Frameworks/${product_name}.framework" \
        -framework "${ARCHIVE_DIR}/${product_name}-appletvos.xcarchive/Products/Library/Frameworks/${product_name}.framework" \
        -framework "${ARCHIVE_DIR}/${product_name}-appletvsimulator.xcarchive/Products/Library/Frameworks/${product_name}.framework" \
        -output "${out_path}"

    # App Store validation rejects embedded frameworks whose Info.plist lacks
    # CFBundleShortVersionString (ITMS error 90057). Fail the build here rather
    # than let consumers discover it at upload time — shipped broken in 0.4.4.
    local plist found
    while IFS= read -r plist; do
        found="$(plutil -extract CFBundleShortVersionString raw "${plist}" 2>/dev/null || true)"
        if [[ "${found}" != "${SDK_VERSION}" ]]; then
            echo "error: ${plist} CFBundleShortVersionString='${found}' (expected '${SDK_VERSION}')" 1>&2
            exit 1
        fi
    done < <(find "${out_path}" -name Info.plist -path "*.framework/*")

    # Independent check on `patch_swiftinterface_into_framework`'s output.
    # Its filters are only as good as our understanding of a DerivedData
    # layout Xcode is free to change; this reads the assembled artifact and
    # asserts the property that actually matters to consumers. Runs for Debug
    # too — the dev loop consumes dist/ directly, so a mis-copied interface
    # breaks a local RN build exactly the same way.
    "${SCRIPT_DIR}/verify-slice-parity.sh" "${out_path}"
}

# Zip + checksum. SwiftPM's `.binaryTarget(url:checksum:)` needs the SHA256
# of the zip; CocoaPods needs the zip itself.
package_xcframework() {
    local product_name="$1"
    local zip_path="${DIST_DIR}/${product_name}.xcframework.zip"

    # Debug builds produce NO distributable artifacts. See the combined-zip
    # block near the bottom for the full reasoning; the short version is that
    # a Debug zip is byte-for-byte indistinguishable BY NAME from a release
    # one, and the dev loop never reads the zips anyway — scripts/dev/rn.mjs
    # consumes the unzipped dist/<Product>.xcframework directory.
    if [[ "${CONFIGURATION}" != "Release" ]]; then
        echo "==> skip zip + checksum ${product_name} (configuration=${CONFIGURATION}, not publishable)"
        return
    fi

    echo "==> zip + checksum ${product_name}"
    (cd "${DIST_DIR}" && rm -f "${product_name}.xcframework.zip" \
        && zip -q -r "${product_name}.xcframework.zip" "${product_name}.xcframework")
    shasum -a 256 "${zip_path}" | awk '{print $1}' > "${zip_path}.sha256"
    echo "    zip:      ${zip_path}"
    echo "    sha256:   $(cat "${zip_path}.sha256")"
}

# Write the freshly computed SHA256s back into Package.binary.swift.
#
# Until this existed, NOTHING wrote them: sync-version.sh propagates the
# version literal only, and this script merely printed the hashes and left a
# comment telling a human to copy them across. So every version bump produced
# a manifest whose `v<new>/` URLs were paired with the PREVIOUS release's
# checksums, and SwiftPM rejected the fetch — which is exactly what happened
# to 0.5.0 (its manifest carried verified-identical 0.4.5 hashes). The fix is
# to stop asking a human to remember.
#
# Release-only, deliberately: a Debug build (EVERFRAME_XCFRAMEWORK_CONFIGURATION
# =Debug, used by scripts/dev/rn.mjs) produces artifacts that must NEVER be
# published, so its hashes must never reach the distribution manifest.
# ORDERING: this must run AFTER the combined CocoaPods zip exists. The
# verifier it ends with checks EVERY release asset, and the CocoaPods zip is
# one of them — so calling this before the zip is built aborts the run at the
# last statement of an otherwise complete Release build, with a message telling
# the maintainer to run the script that just died. That shipped, and the reason
# it survived review is that the guard was only ever exercised against a
# hand-made `dist/`; Debug builds return early here, so the dev loop never hit
# it either. Asserted below rather than left to the call site's position in the
# file, because a comment does not survive the next edit.
sync_binary_checksums() {
    local manifest="${PKG_DIR}/Package.binary.swift"

    if [[ "${CONFIGURATION}" != "Release" ]]; then
        echo "==> skip Package.binary.swift checksum sync (configuration=${CONFIGURATION}, not publishable)"
        return
    fi

    if [[ ! -f "${COMBINED_ZIP}" ]]; then
        echo "error: internal ordering bug — sync_binary_checksums ran before" 1>&2
        echo "       ${COMBINED_ZIP} was built." 1>&2
        echo "       Its final verify step requires every release asset, the CocoaPods" 1>&2
        echo "       zip included. Move the sync_binary_checksums call back below the" 1>&2
        echo "       combined-zip block at the bottom of this script." 1>&2
        exit 1
    fi

    echo "==> sync checksums into Package.binary.swift"

    local sums="${DIST_DIR}/.checksums.tsv"
    : > "${sums}"
    local s
    for s in EverframeProtocol EverframeKit EverframeReporterUI; do
        printf '%s\t%s\n' "${s}" "$(cat "${DIST_DIR}/${s}.xcframework.zip.sha256")" >> "${sums}"
    done

    local tmp
    tmp="$(mktemp)"
    awk -v sums="${sums}" '
        BEGIN { while ((getline line < sums) > 0) { split(line, f, "\t"); sha[f[1]] = f[2] } }
        /\.binaryTarget\(/ { inblk = 1; cur = "" }
        inblk && /name:/     { if (match($0, /"[^"]+"/)) cur = substr($0, RSTART + 1, RLENGTH - 2) }
        inblk && /checksum:/ {
            if (cur != "" && cur in sha) sub(/"[0-9a-fA-F]*"/, "\"" sha[cur] "\"")
            inblk = 0
        }
        { print }
    ' "${manifest}" > "${tmp}"
    mv "${tmp}" "${manifest}"

    # Not a tautology: if the awk substitution silently matched nothing (the
    # manifest layout drifted, a target was renamed), the manifest still holds
    # the old hashes and this goes red instead of shipping them.
    "${SCRIPT_DIR}/verify-binary-checksums.sh" --dist "${DIST_DIR}"
}

# Each scheme must be archived once per (sdk, platform) combination.
# XcodeGen with `platform: [iOS, tvOS]` generates the target for both —
# the scheme name stays the same; -destination picks the slice.
for scheme in EverframeProtocol EverframeKit EverframeReporterUI; do
    archive "${scheme}" iphoneos          "generic/platform=iOS"                "${ARCHIVE_DIR}/${scheme}-iphoneos.xcarchive"
    archive "${scheme}" iphonesimulator   "generic/platform=iOS Simulator"      "${ARCHIVE_DIR}/${scheme}-iphonesimulator.xcarchive"
    archive "${scheme}" appletvos         "generic/platform=tvOS"               "${ARCHIVE_DIR}/${scheme}-appletvos.xcarchive"
    archive "${scheme}" appletvsimulator  "generic/platform=tvOS Simulator"     "${ARCHIVE_DIR}/${scheme}-appletvsimulator.xcarchive"

    create_xcframework "${scheme}"
    package_xcframework "${scheme}"
done

# Combined CocoaPods zip — both xcframeworks in one archive so the single
# `spec.source` line can satisfy both Core and ReporterUI subspecs (CocoaPods
# disallows per-subspec :source). Named off the podspec version, exactly like
# every other asset (see the SDK_VERSION block near the top).
#
# This is built BEFORE `sync_binary_checksums`, and the order is not cosmetic:
# that function ends by verifying dist/ against the manifest, and the verifier
# counts this zip as a release asset. With the two the other way round every
# Release build aborted here — see the assertion inside the function.
#
# RELEASE-ONLY, and this is a safety property rather than an optimisation.
# A Debug build's zip carries the SAME filename as a release one —
# Everframe-<podspec version>.zip — while containing an xcframework compiled
# with `#if DEBUG` live: it reads EVERFRAME_DEV_INGEST_URL from the process
# env and EverframeDevIngestURL from the host Info.plist. Publish that by
# mistake and every consumer's reports go wherever the developer's shell
# pointed. `spec.source` is fetched by checksum from a public URL and
# CocoaPods versions are immutable, so it cannot be taken back.
#
# The dev loop leaves exactly that state behind: scripts/dev/rn.mjs builds
# dist/ with EVERFRAME_XCFRAMEWORK_CONFIGURATION=Debug on every RN iOS run.
# Before this guard the only thing separating that dist/ from a publishable
# one was the .xcframework-config sentinel and the maintainer remembering to
# rebuild. Emitting nothing publishable in Debug replaces "remember" with
# "there is no such file". (Package.binary.swift is already protected —
# sync_binary_checksums below returns early for non-Release — so this closes
# the CocoaPods half of the same hole.)
if [[ "${CONFIGURATION}" == "Release" ]]; then
    echo "==> combined CocoaPods zip → Everframe-${COMBINED_VERSION}.zip"
    (cd "${DIST_DIR}" && rm -f "Everframe-${COMBINED_VERSION}.zip" \
        && zip -q -r "Everframe-${COMBINED_VERSION}.zip" \
            EverframeProtocol.xcframework EverframeKit.xcframework EverframeReporterUI.xcframework \
        && zip -q -j "Everframe-${COMBINED_VERSION}.zip" "${REPO_DIR}/LICENSE")
    shasum -a 256 "${COMBINED_ZIP}" | awk '{print $1}' > "${COMBINED_ZIP}.sha256"
else
    echo "==> skip combined CocoaPods zip (configuration=${CONFIGURATION}, not publishable)"
fi

sync_binary_checksums

# Sentinel for staleness checks in dev tooling (scripts/dev/rn.mjs and the
# with-everframe-ios-local Expo plugin): records which configuration dist/
# was built with, so a config switch forces a rebuild even when Sources/
# mtimes say "fresh". Written LAST so an aborted build (dist/ wiped above)
# leaves no sentinel and always reads as stale.
echo "${CONFIGURATION}" > "${DIST_DIR}/.xcframework-config"

echo ""
echo "✓ built (${CONFIGURATION}):"
if [[ "${CONFIGURATION}" == "Release" ]]; then
    ls -lh "${DIST_DIR}"/*.xcframework.zip "${COMBINED_ZIP}"
else
    # No zips exist in Debug (see the guards above), and `ls` on a glob that
    # matches nothing fails the script under `set -e`. List what a Debug build
    # actually produces — the xcframeworks the dev loop consumes directly.
    ls -ld "${DIST_DIR}"/*.xcframework
    echo ""
    echo "  Debug build: no .zip / .sha256 emitted — these artifacts are not publishable."
    echo "  Rebuild without EVERFRAME_XCFRAMEWORK_CONFIGURATION to produce release assets."
fi

# Checksums exist only for release assets. In Debug there are no zips to hash,
# and `cat` on the missing .sha256 files would abort the run at its very last
# statement — after a build that otherwise succeeded.
if [[ "${CONFIGURATION}" == "Release" ]]; then
    echo ""
    echo "Checksums:"
    for s in EverframeProtocol EverframeKit EverframeReporterUI; do
        printf "  %-30s  %s\n" "${s}.xcframework.zip" "$(cat "${DIST_DIR}/${s}.xcframework.zip.sha256")"
    done
    printf "  %-30s  %s\n" "Everframe-${COMBINED_VERSION}.zip" "$(cat "${COMBINED_ZIP}.sha256")"
fi
