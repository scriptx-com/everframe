// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
@_implementationOnly import EverframeCrashRecorder

/// The only Swift bridge to the process-global recorder. All calls are made
/// on healthy threads; no Swift callback is registered with the fatal writer.
enum NativeCrashRecorderAdapter {
    static func makeRuntime() -> NativeCrashRuntime? {
        // XCTest must not mutate process fatal handlers or persistent app state.
        // CLI XCTest, simulator XCTest and Swift Testing advertise differently.
        // The Swift Testing helper loads the test bundle/XCTest classes but
        // does not supply either XCTest host identifier.
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil,
              Bundle.main.bundleIdentifier != "com.apple.dt.xctest.tool",
              NSClassFromString("XCTestCase") == nil else { return nil }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].resolvingSymlinksInPath()
        return NativeCrashRuntime(rootURL: caches.appendingPathComponent("dev.everframe.native-crash"),
            outbox: JSONLOutbox(), recorder: .init(
                install: { path in recorderDirectory(path)?.withCString { EFCRInstall($0) == EFCRInstallSuccess } ?? false },
                disable: { _ = EFCRSetEnabled(false) },
                publish: { id in
                    guard id.uuidString.lowercased().withCString({ EFCRSetContextIdentifier($0) }) else { return false }
                    return EFCRSetEnabled(true)
                }))
    }

    /// The recorder accepts only realpath(3)'s spelling of its run directory.
    /// Foundation reports device containers as /var/..., which realpath spells
    /// /private/var/...; the recorder would reject the Foundation spelling.
    static func recorderDirectory(_ url: URL) -> String? {
        guard let resolved = realpath(url.path, nil) else { return nil }
        defer { free(resolved) }
        return String(cString: resolved)
    }
}
