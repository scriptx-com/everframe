// swift-tools-version: 6.0
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import PackageDescription

let package = Package(
    name: "macos-window-capture-probe",
    platforms: [.macOS(.v15)],
    products: [.executable(name: "macos-window-capture-probe", targets: ["WindowProbe"])],
    targets: [
        .executableTarget(name: "WindowProbe"),
        .testTarget(name: "WindowProbeTests", dependencies: ["WindowProbe"]),
    ]
)
