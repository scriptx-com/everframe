// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Applies `CaptureGestureRule` to a shake, the simulator's capture
// notification or the Siri Remote binding: quick capture, the shake-to-report
// path, or nothing, plus a device-link hello when the rule asks for one. The
// decision goes back to the caller, which needs `swallowKeys` for the remote.
//
// The router never reads the shake-to-report switch. `shakeToReport` decides
// only whether the reporter path opens the reporter; shake still captures on
// linked and debug devices, and still says hello, with it off.
#if canImport(UIKit)
import UIKit

@MainActor
struct CaptureGestureRouter {
    typealias Inputs = (hostMode: QuickCaptureHostMode, configured: Bool, debug: Bool, linked: Bool, linkingEnabled: Bool)

    var inputs: @MainActor () -> Inputs
    var quickCapture: @MainActor (QuickCaptureTrigger) -> Void
    var reporter: @MainActor () -> Void
    var hello: @MainActor () -> Void

    /// Reads `QuickCapture.shared` and `DeviceLinkCoordinator.shared`.
    static var live: CaptureGestureRouter { make(for: .shared, coordinator: .shared) }

    static func make(for capture: QuickCapture, coordinator: DeviceLinkCoordinator) -> CaptureGestureRouter {
        CaptureGestureRouter(
            inputs: { (capture.hostMode, capture.isConfigured, capture.isDebug, capture.isLinked,
                       coordinator.isLinkingEnabled) },
            quickCapture: { capture.startCapture(trigger: $0) },
            reporter: {
                #if os(iOS) && !targetEnvironment(macCatalyst)
                ShakeToReportTrigger.shared.handleShake()
                #endif
            },
            hello: { coordinator.sendHelloIfIdle() })
    }

    @discardableResult
    func handle(_ source: CaptureGestureSource) -> CaptureGestureDecision {
        let current = inputs()
        let decision = CaptureGestureRule.decide(
            source: source, hostMode: current.hostMode, quickCaptureConfigured: current.configured,
            debug: current.debug, linked: current.linked, linkingEnabled: current.linkingEnabled)
        switch decision.action {
        case .quickCapture:
            switch source {
            case .shake: quickCapture(.shake)
            case .simulatorNotification: quickCapture(.hotkey)
            case .remote: quickCapture(.remote)
            }
        case .reporter: reporter()
        case .nothing: break
        }
        if decision.sendHello { hello() }
        return decision
    }
}
#endif
