// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

enum TerminationPlatform {
    static let simulatorOptIn = "EVERFRAME_SIMULATOR_TERMINATION_INFERENCE"
    /// Apps only: no extensions (routinely killed, no UIApplication lifecycle, tiny limits), no Mac
    /// runtimes (Activity Monitor quits look like kills; no jetsam), and no simulator unless the proof
    /// opts in (its kern.boottime is the host's, so a simulator shutdown would look like a kill).
    static func isEligible(bundleURL: URL = Bundle.main.bundleURL, process: ProcessInfo = .processInfo) -> Bool {
        #if os(iOS) || os(tvOS)
        guard bundleURL.pathExtension != "appex", !process.isMacCatalystApp, !process.isiOSAppOnMac else { return false }
        #if targetEnvironment(simulator)
        return process.environment[simulatorOptIn] == "1"
        #else
        return true
        #endif
        #else
        return false
        #endif
    }
}
