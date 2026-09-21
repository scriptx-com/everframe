// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import TraceItXProtocol

enum VitalsDims {
    static func current(sdkVersion: String,
                        infoDictionary: [String: Any]? = Bundle.main.infoDictionary,
                        machine: String = machineIdentifier(),
                        osVersion: OperatingSystemVersion = ProcessInfo.processInfo.operatingSystemVersion) -> SessionSummaryDims {
        #if os(tvOS)
        let platform = "tvos"
        #else
        let platform = "ios"
        #endif
        return SessionSummaryDims(
            platform: platform,
            appVersion: (infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0",
            sdkVersion: sdkVersion,
            deviceModel: machine,
            osVersion: "\(osVersion.majorVersion).\(osVersion.minorVersion).\(osVersion.patchVersion)")
    }

    /// `utsname.machine` — "iPhone16,1", "AppleTV14,1", "arm64" on the simulator/macOS.
    static func machineIdentifier() -> String {
        var sys = utsname()
        uname(&sys)
        return withUnsafePointer(to: &sys.machine) { $0.withMemoryRebound(to: CChar.self, capacity: 256) { String(cString: $0) } }
    }
}
