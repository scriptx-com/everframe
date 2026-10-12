// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

/// Whether the host app is a debug build, so Everframe never creates a release from it. `#if DEBUG`
/// would describe how this SDK was compiled, not the app. A simulator build, or one signed for
/// development (its embedded profile has `get-task-allow`), is a debug build; TestFlight and App
/// Store builds are not. `EverframeConfig.debugBuild` overrides the detection when set. This is the
/// one answer every consumer uses: the envelopes' `context.app.debug`, release-health records, and
/// the release-health debug-build skip.
enum DebugBuild {
    /// `configured` wins when set; otherwise the signing check in `DebugBuildDetector` decides.
    static func detect(configured: Bool?, isSimulator: Bool, provisioningProfile: Data?) -> Bool {
        configured ?? DebugBuildDetector.isDebugBuild(profile: provisioningProfile, isSimulator: isSimulator)
    }

    /// The running app's answer. Detection reads the bundle once per process.
    static func current(configured: Bool?) -> Bool { configured ?? DebugBuildDetector.current }
}
