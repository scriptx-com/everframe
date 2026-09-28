// swift-tools-version: 5.10
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import PackageDescription
import Foundation

// Flutter links plugins into an ephemeral SwiftPM directory. The local SDK
// path must therefore be absolute for this unreleased source dry run.
guard let sdkPath = ProcessInfo.processInfo.environment["EVERFRAME_SDK_IOS_ROOT"],
      sdkPath.hasPrefix("/") else {
    fatalError("EVERFRAME_SDK_IOS_ROOT must be an absolute path to packages/sdk-ios")
}

let package = Package(
    name: "everframe_flutter",
    platforms: [.iOS(.v15)],
    products: [.library(name: "everframe-flutter", targets: ["everframe_flutter"])],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework"),
        .package(name: "Everframe", path: sdkPath),
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
