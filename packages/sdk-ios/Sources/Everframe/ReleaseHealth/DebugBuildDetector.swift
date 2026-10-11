// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Release health skips debug builds. The SDK ships prebuilt, so the host app's `DEBUG` flag never
/// reaches it, and the check runs at run time. A debug build runs in the simulator (the xcframework
/// has a separate simulator slice), or carries an `embedded.mobileprovision` whose entitlements set
/// `get-task-allow`, as Xcode development signing does. App Store and TestFlight builds have no
/// profile; ad hoc and enterprise profiles set `get-task-allow` to false. A profile that can't be
/// read counts as a release build: losing real users' sessions is worse than recording an
/// occasional development one.
enum DebugBuildDetector {
    /// Read once per process, on first use; the bundle can't change while the app runs.
    static let current: Bool = {
        #if targetEnvironment(simulator)
        return DebugBuildDetector.isDebugBuild(profile: nil, isSimulator: true)
        #else
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
        return DebugBuildDetector.isDebugBuild(profile: profile, isSimulator: false)
        #endif
    }()

    static func isDebugBuild(profile: Data?, isSimulator: Bool) -> Bool {
        if isSimulator { return true }
        guard let profile, let plist = embeddedPlist(in: profile),
              let root = try? PropertyListSerialization.propertyList(from: plist, options: [], format: nil) as? [String: Any],
              let entitlements = root["Entitlements"] as? [String: Any] else { return false }
        return (entitlements["get-task-allow"] as? Bool) == true
    }

    /// The profile is a signed CMS container whose payload, an XML plist, is stored as plain bytes.
    static func embeddedPlist(in profile: Data) -> Data? {
        guard let start = profile.range(of: Data("<?xml".utf8)),
              let end = profile.range(of: Data("</plist>".utf8), in: start.upperBound..<profile.endIndex) else { return nil }
        return profile.subdata(in: start.lowerBound..<end.upperBound)
    }
}
