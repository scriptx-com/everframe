// swift-tools-version: 5.10
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 ScriptX
//
// BINARY-DISTRIBUTION Package.swift. NOT used during local development —
// `Package.swift` (the source-based manifest) is the working file. At release
// time the publishing runbook (PUBLISHING.md) renames this file to
// `Package.swift` on the `release/<version>` branch, after updating the
// `binaryVersion` constant + each `checksum:` to match the artifacts attached
// to the GitHub Release on `scriptx-com/traceitx-releases`. The xcframework
// zips are public on that repo so anonymous SwiftPM consumers can fetch them.
//
// Consumers reference the binary tag, e.g.
//
//     dependencies: [
//         .package(url: "https://github.com/scriptx-com/traceitx-releases", from: "0.1.1"),
//     ]
//
// **Update these per release — both are now automated; do not hand-edit:**
//   * binaryVersion   — the SemVer string of the release. Written by
//                       `scripts/sync-version.sh` from TraceItX.podspec.
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
//   * TraceItXKit          — the core SDK (was published as TraceItX in 0.1.0)
//   * TraceItXProtocol     — wire-format types referenced by TraceItXKit's
//                            .swiftinterface; SwiftPM can't resolve the import
//                            unless this is a visible dependency target, even
//                            though no consumer imports it directly.
//   * TraceItXReporterUI   — optional reporter modal (opt-in via product).
import PackageDescription

let binaryVersion = "0.8.0"
let baseURL = "https://github.com/scriptx-com/traceitx-releases/releases/download/v\(binaryVersion)/"

let package = Package(
    name: "TraceItX",
    platforms: [.iOS(.v15), .tvOS(.v15)],
    products: [
        // Public product name stays `TraceItX` for source-compat with the
        // 0.1.0 manifest. It depends on both Kit + Protocol so a consumer
        // `import TraceItX` resolves the .swiftinterface symbols.
        .library(name: "TraceItX",           targets: ["TraceItXKit", "TraceItXProtocol"]),
        .library(name: "TraceItXReporterUI", targets: ["TraceItXReporterUI"]),
    ],
    targets: [
        // NOTE: the checksums below must match the zips actually attached to
        // the GitHub Release on `scriptx-com/traceitx-releases`. The local
        // `dist/` directory may be ahead of the published artifacts after a
        // rebuild, so the authoritative check hashes the *fetched* zips:
        //     scripts/verify-binary-checksums.sh
        .binaryTarget(
            name: "TraceItXKit",
            url: baseURL + "TraceItXKit.xcframework.zip",
            checksum: "8148fd0dedf2beac1cedf45acfbb1ad035a26bcede27f949fd9d931a5623c709"
        ),
        .binaryTarget(
            name: "TraceItXProtocol",
            url: baseURL + "TraceItXProtocol.xcframework.zip",
            checksum: "902cd4d1d7fe3eb962922cd0669e702ac35b4ade525568bad225778a3b78e337"
        ),
        .binaryTarget(
            name: "TraceItXReporterUI",
            url: baseURL + "TraceItXReporterUI.xcframework.zip",
            checksum: "feb0023f935d6e3014a6d9d57255b947dfa8cc71be379dfba48ba23f7ac40d13"
        ),
    ]
)
