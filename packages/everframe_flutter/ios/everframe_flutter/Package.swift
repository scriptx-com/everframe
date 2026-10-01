// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import PackageDescription
import Foundation

// Consumers resolve the published native SDK. Contributors can point at the
// source package while developing changes that have not been released yet.
let nativeSDK: Package.Dependency
if let sdkPath = ProcessInfo.processInfo.environment["EVERFRAME_SDK_IOS_ROOT"],
   !sdkPath.isEmpty {
    guard sdkPath.hasPrefix("/") else {
        fatalError("EVERFRAME_SDK_IOS_ROOT must be an absolute path to packages/sdk-ios")
    }
    nativeSDK = .package(name: "Everframe", path: sdkPath)
} else {
    nativeSDK = .package(url: "https://github.com/scriptx-com/everframe.git",
                         .upToNextMinor(from: "0.10.1"))
}

let package = Package(
    name: "everframe_flutter",
    platforms: [.iOS(.v15)],
    products: [.library(name: "everframe-flutter", targets: ["everframe_flutter"])],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        nativeSDK,
    ],
    targets: [
        .target(
            name: "everframe_flutter",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework"),
                .product(name: "Everframe", package: "Everframe"),
                .product(name: "EverframeReporterUI", package: "Everframe"),
            ]
        ),
    ]
)
