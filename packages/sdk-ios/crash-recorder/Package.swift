// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import PackageDescription
let headers = [".", "Vendor/KSCrashCore/include", "Vendor/KSCrashRecordingCore/include",
               "Vendor/KSCrashRecording/include", "Vendor/KSCrashRecording", "Vendor/KSCrashRecording/Monitors"]
let package = Package(
    name: "EverframeCrashRecorder",
    platforms: [.iOS(.v15), .tvOS(.v15), .macOS(.v14)],
    products: [.library(name: "EverframeCrashRecorder", targets: ["EverframeCrashRecorder"])],
    targets: [.target(
        name: "EverframeCrashRecorder",
        exclude: ["Vendor/KSCrashCore/Resources", "Vendor/KSCrashRecordingCore/Resources", "Vendor/KSCrashRecording/Resources"],
        resources: [
            .process("Resources/PrivacyInfo.xcprivacy"),
        ],
        publicHeadersPath: "include",
        cSettings: headers.map { .headerSearchPath($0) },
        cxxSettings: headers.map { .headerSearchPath($0) },
        linkerSettings: [.linkedFramework("Foundation"), .linkedLibrary("c++")]
    ),
    .target(name: "EFCRProbeNative", dependencies: ["EverframeCrashRecorder"], path: "Tests/ProbeNative",
        cSettings: headers.map { .headerSearchPath("../../Sources/EverframeCrashRecorder/" + $0) }),
    .executableTarget(name: "EFCRProbe", dependencies: ["EverframeCrashRecorder", "EFCRProbeNative"], path: "Tests/Probe")
    ],
    cLanguageStandard: .gnu11,
    cxxLanguageStandard: .gnucxx11
)
