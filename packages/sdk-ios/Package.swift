// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import PackageDescription

let package = Package(
    name: "TraceItX",
    // iOS/tvOS 15 is the floor — pinned by `UIButton.Configuration` (used
    // in ReporterViewController) which requires iOS 15+. Other gates we hit
    // along the way: `os.Logger` needs 14+ (InternalLogger, LogCapture).
    // No iOS 16/17 APIs are used, so 15 is the absolute floor without
    // refactoring the reporter modal's button-configuration code.
    // macOS is added so `swift build` works on macOS host CI runners.
    // The macOS slice ships test/CI only — iOS/tvOS are the published products.
    platforms: [.iOS(.v15), .tvOS(.v15), .macOS(.v14)],
    // Module name `TraceItXKit` (not `TraceItX`) avoids the Swift library-
    // evolution collision where `module TraceItX` + `public class TraceItX`
    // makes .swiftinterface unparseable. The SPM target stays for the
    // development workflow (`swift test`); production distribution is via
    // CocoaPods + the XcodeGen-generated xcframework (project.yml).
    products: [
        .library(name: "TraceItXKit", targets: ["TraceItXKit"]),
        .library(name: "TraceItXProtocol", targets: ["TraceItXProtocol"]),
        .library(name: "TraceItXReporterUI", targets: ["TraceItXReporterUI"]),
        .library(name: "TraceItXBench", targets: ["TraceItXBench"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "TraceItXProtocol",
            path: "Sources/TraceItXProtocol"
        ),
        .target(
            name: "TraceItXKit",
            dependencies: ["TraceItXProtocol"],
            path: "Sources/TraceItX",
            resources: [
                .copy("PrivacyInfo.xcprivacy"),
                .process("Resources"),
            ],
            swiftSettings: [
                .enableExperimentalFeature("StrictConcurrency=complete"),
                // SPM mirrors the published artifact: module-name == target-name
                // gives us the same `import TraceItXKit` usage in both paths.
                .define("SWIFT_PACKAGE"),
            ]
        ),
        .target(
            name: "TraceItXReporterUI",
            dependencies: ["TraceItXKit", "TraceItXProtocol"],
            path: "Sources/TraceItXReporterUI"
        ),
        .testTarget(
            name: "TraceItXTests",
            dependencies: ["TraceItXKit", "TraceItXProtocol"],
            path: "Tests/TraceItXTests",
            resources: [
                .process("Fixtures"),
            ]
        ),
        .testTarget(
            name: "TraceItXReporterUITests",
            dependencies: ["TraceItXKit", "TraceItXReporterUI"],
            path: "Tests/TraceItXReporterUITests"
        ),
        .target(
            name: "TraceItXBench",
            // Depends on TraceItXKit so the VTree producer overhead bench (Phase
            // 22-04) can exercise the real walk + sampling tick engine, not a copy.
            dependencies: ["TraceItXProtocol", "TraceItXKit"],
            path: "Sources/TraceItXBench"
        ),
        .testTarget(
            name: "TraceItXBenchTests",
            dependencies: ["TraceItXBench", "TraceItXKit", "TraceItXProtocol"],
            path: "Tests/TraceItXBenchTests"
        ),
    ]
)
