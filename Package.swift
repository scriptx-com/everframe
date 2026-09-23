// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Binary-distribution manifest used by tagged releases and SwiftPM consumers.
// Contributor source builds use packages/sdk-ios/Package.swift. Release
// automation updates binaryVersion and the checksums below to match the
// xcframework archives attached to the corresponding GitHub release.
//
// Consumers reference the binary tag, e.g.
//
//     dependencies: [
//         .package(url: "https://github.com/scriptx-com/everframe", from: "0.9.0"),
//     ]
//
// Never hand-edit one without the other: a version/checksum mismatch makes
// SwiftPM reject the downloaded artifact.
//
// Three binary targets ship in lockstep:
//   * EverframeKit          — the core SDK
//   * EverframeProtocol     — wire-format types referenced by EverframeKit's
//                            .swiftinterface; SwiftPM can't resolve the import
//                            unless this is a visible dependency target, even
//                            though no consumer imports it directly.
//   * EverframeReporterUI   — optional reporter modal (opt-in via product).
import PackageDescription

let binaryVersion = "0.8.2"
let baseURL = "https://github.com/scriptx-com/everframe/releases/download/v\(binaryVersion)/"

let package = Package(
    name: "Everframe",
    platforms: [.iOS(.v15), .tvOS(.v15)],
    products: [
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
            checksum: "74be21575fa6e3de549458534fd636f928c73ff53589e0d73df466193514832d"
        ),
        .binaryTarget(
            name: "EverframeProtocol",
            url: baseURL + "EverframeProtocol.xcframework.zip",
            checksum: "8a493abb9ce9f832e2cffe5c829d528c6db75ee5bb5e2fa9af988a1af1b0132d"
        ),
        .binaryTarget(
            name: "EverframeReporterUI",
            url: baseURL + "EverframeReporterUI.xcframework.zip",
            checksum: "9dc53325a8ddb2486e9877c3d2007b59ae07f649302cfbe7b726495dba2c054f"
        ),
    ]
)
