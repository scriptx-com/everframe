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
//         .package(url: "https://github.com/scriptx-com/everframe", from: "1.0.0"),
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

let binaryVersion = "1.2.0"
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
            checksum: "488b4d0443fd4bd5ca157da423fe451f8359f2cbea4e4e6b1865e2e905bbac67"
        ),
        .binaryTarget(
            name: "EverframeProtocol",
            url: baseURL + "EverframeProtocol.xcframework.zip",
            checksum: "c13c34bf2c0d4fd9a7f6bdf49a8bde39ae609431694bd2be05ba2cac963ed71e"
        ),
        .binaryTarget(
            name: "EverframeReporterUI",
            url: baseURL + "EverframeReporterUI.xcframework.zip",
            checksum: "e9d11301fe1e83c2e7bd0772d72627deddffc54bbc1a28f2f9008d178f34edd7"
        ),
    ]
)
