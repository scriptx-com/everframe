// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// BINARY-DISTRIBUTION Package.swift. NOT used during local development —
// `Package.swift` (the source-based manifest) is the working file. At release
// time the publishing runbook (PUBLISHING.md) renames this file to
// `Package.swift` on the `release/<version>` branch, after updating the
// `binaryVersion` constant + each `checksum:` to match the artifacts attached
// to the GitHub Release on `scriptx-com/everframe`. The xcframework
// zips are public on that repo so anonymous SwiftPM consumers can fetch them.
//
// Consumers reference the binary tag, e.g.
//
//     dependencies: [
//         .package(url: "https://github.com/scriptx-com/everframe", from: "0.9.0"),
//     ]
//
// **Update these per release — both are now automated; do not hand-edit:**
//   * binaryVersion   — the SemVer string of the release. Written by
//                       `scripts/sync-version.sh` from Everframe.podspec.
//   * each binaryTarget's `checksum:` — written by
//                       `scripts/build-xcframework.sh` (Release builds only)
//                       from the zips it just produced.
//
// The two are written at DIFFERENT times, and that gap is the trap: a version
// bump alone (sync-version.sh, or any release-prep script that calls it)
// advances `binaryVersion` while leaving the PREVIOUS release's checksums in
// place. The manifest then looks plausible and is completely broken — SwiftPM
// rejects every fetch with "checksum of downloaded artifact does not match".
// v0.5.0 shipped into this exact state carrying 0.4.5 hashes.
//
// `scripts/verify-binary-checksums.sh` is the guard. Run it against the
// published artifacts before `pod trunk push` (PUBLISHING.md §6); it is also
// available as the `release-verify` workflow. On a feature branch that has
// bumped ahead of the release, `--allow-unpublished` is the honest answer —
// inventing placeholder checksums is not.
//
// Three binary targets ship in lockstep:
//   * EverframeKit          — the core SDK (was published as Everframe in 0.1.0)
//   * EverframeProtocol     — wire-format types referenced by EverframeKit's
//                            .swiftinterface; SwiftPM can't resolve the import
//                            unless this is a visible dependency target, even
//                            though no consumer imports it directly.
//   * EverframeReporterUI   — optional reporter modal (opt-in via product).
import PackageDescription

let binaryVersion = "0.10.1"
let baseURL = "https://github.com/scriptx-com/everframe/releases/download/v\(binaryVersion)/"

let package = Package(
    name: "Everframe",
    platforms: [.iOS(.v15), .tvOS(.v15)],
    products: [
        // The public package product is `Everframe`; its module remains
        // `EverframeKit`. Protocol is included so that module's public
        // interfaces resolve for consumers.
        .library(name: "Everframe",           targets: ["EverframeKit", "EverframeProtocol"]),
        .library(name: "EverframeReporterUI", targets: ["EverframeReporterUI"]),
    ],
    targets: [
        // NOTE: the checksums below must match the zips actually attached to
        // the GitHub Release on `scriptx-com/everframe`. The local
        // `dist/` directory may be ahead of the published artifacts after a
        // rebuild, so the authoritative check hashes the *fetched* zips:
        //     scripts/verify-binary-checksums.sh
        .binaryTarget(
            name: "EverframeKit",
            url: baseURL + "EverframeKit.xcframework.zip",
            checksum: "690d328583d579a5757594bd2bd5027e4b3f2e42ecadd8d17a77107c121db863"
        ),
        .binaryTarget(
            name: "EverframeProtocol",
            url: baseURL + "EverframeProtocol.xcframework.zip",
            checksum: "ddc610240541e2d2a9bcd9682ccbda1ca55d74b43b877f220aa1ac66abcf16f7"
        ),
        .binaryTarget(
            name: "EverframeReporterUI",
            url: baseURL + "EverframeReporterUI.xcframework.zip",
            checksum: "93bce69b0111488ea725749c3a6bda1730b626d8eea93f2d20ba7e4a1ee05e8e"
        ),
    ]
)
