// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import PackageDescription

let package = Package(
    name: "Everframe",
    // iOS/tvOS 15 is the floor — pinned by `UIButton.Configuration` (used
    // in ReporterViewController) which requires iOS 15+. Other gates we hit
    // along the way: `os.Logger` needs 14+ (InternalLogger, LogCapture).
    // No iOS 16/17 APIs are used, so 15 is the absolute floor without
    // refactoring the reporter modal's button-configuration code.
    // macOS is added so `swift build` works on macOS host CI runners.
    // The macOS slice ships test/CI only — iOS/tvOS are the published products.
    platforms: [.iOS(.v15), .tvOS(.v15), .macOS(.v14)],
    // Module name `EverframeKit` (not `Everframe`) avoids the Swift library-
    // evolution collision where `module Everframe` + `public class Everframe`
    // makes .swiftinterface unparseable. The SPM target stays for the
    // development workflow (`swift test`); production distribution is via
    // CocoaPods + the XcodeGen-generated xcframework (project.yml).
    products: [
        .library(name: "Everframe", targets: ["EverframeKit", "EverframeProtocol"]),
        .library(name: "EverframeReporterUI", targets: ["EverframeReporterUI"]),
        .library(name: "EverframeBench", targets: ["EverframeBench"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "EverframeProtocol",
            path: "Sources/EverframeProtocol"
        ),
        .target(
            name: "EverframeKit",
            dependencies: ["EverframeProtocol"],
            path: "Sources/Everframe",
            resources: [
                .copy("PrivacyInfo.xcprivacy"),
                .process("Resources"),
            ],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency=complete"),
                // SPM mirrors the published artifact: module-name == target-name
                // gives us the same `import EverframeKit` usage in both paths.
                .define("SWIFT_PACKAGE"),
            ]
        ),
        .target(
            name: "EverframeReporterUI",
            dependencies: ["EverframeKit", "EverframeProtocol"],
            path: "Sources/EverframeReporterUI"
        ),
        .testTarget(
            name: "EverframeTests",
            dependencies: ["EverframeKit", "EverframeProtocol"],
            path: "Tests/EverframeTests",
            resources: [
                .process("Fixtures"),
            ]
        ),
        .testTarget(
            name: "EverframeReporterUITests",
            dependencies: ["EverframeKit", "EverframeReporterUI"],
            path: "Tests/EverframeReporterUITests"
        ),
        .target(
            name: "EverframeBench",
            // Depends on EverframeKit so the VTree producer overhead bench (Phase
            // 22-04) can exercise the real walk + sampling tick engine, not a copy.
            dependencies: ["EverframeProtocol", "EverframeKit"],
            path: "Sources/EverframeBench"
        ),
        .testTarget(
            name: "EverframeBenchTests",
            dependencies: ["EverframeBench", "EverframeKit", "EverframeProtocol"],
            path: "Tests/EverframeBenchTests"
        ),
    ]
)
