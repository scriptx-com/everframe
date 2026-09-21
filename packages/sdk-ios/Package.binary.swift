// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
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

let binaryVersion = "0.8.1"
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
            checksum: "197a5f04d3f16af1961f0b491b4370a612c98e82e8f70f3f59b426df50be8153"
        ),
        .binaryTarget(
            name: "TraceItXProtocol",
            url: baseURL + "TraceItXProtocol.xcframework.zip",
            checksum: "de53debb27011dac3692022f106bf019c7ae4647a8b678a874fdf21198a5a554"
        ),
        .binaryTarget(
            name: "TraceItXReporterUI",
            url: baseURL + "TraceItXReporterUI.xcframework.zip",
            checksum: "2a465e69926e2bedd1e6141b07a7cd71c0e23d78cc9cc85de2fd6a411b158862"
        ),
    ]
)
