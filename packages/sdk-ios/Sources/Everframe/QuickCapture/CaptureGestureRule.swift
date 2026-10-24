// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The mode rule: what the capture gesture does on this device.
//
// | Host        | State                                   | Action        | Hello           |
// |-------------|-----------------------------------------|---------------|-----------------|
// | unsupported | any                                     | no reporter*  | no              |
// | simulator   | quick capture configured, debug build   | quick capture | no              |
// | simulator   | otherwise                               | no reporter*  | no              |
// | device      | quick capture not configured            | no reporter*  | no              |
// | device      | linked                                  | quick capture | no              |
// | device      | unlinked, debug build                   | quick capture | if linking is on|
// | device      | unlinked, release build                 | no reporter*  | if linking is on|
//
// * "No reporter" is today's shake: `.reporter` for a shake (the reporter
//   opens only when `shakeToReport` allows it) and `.nothing` for the
//   simulator's capture notification, which never opened the reporter.
//
// `quickCaptureConfigured` is the local `quickCaptureEnabled` and
// `reporterEnabled` options plus the dashboard's `captureHotkey.enabled`:
// a disabled quick capture means no capture and no hello on any device.
import Foundation

enum CaptureGestureSource: Equatable, Sendable {
    case shake
    /// `notifyutil -p com.everframe.capture` in a simulator.
    case simulatorNotification
}

enum CaptureGestureAction: Equatable, Sendable {
    case quickCapture, reporter, nothing
}

struct CaptureGestureDecision: Equatable, Sendable {
    let action: CaptureGestureAction
    let sendHello: Bool
}

enum CaptureGestureRule {
    static func decide(
        source: CaptureGestureSource, hostMode: QuickCaptureHostMode, quickCaptureConfigured: Bool,
        debug: Bool, linked: Bool, linkingEnabled: Bool
    ) -> CaptureGestureDecision {
        let today: CaptureGestureAction = source == .shake ? .reporter : .nothing
        switch hostMode {
        case .unsupported:
            return CaptureGestureDecision(action: today, sendHello: false)
        case .simulator:
            return CaptureGestureDecision(action: quickCaptureConfigured && debug ? .quickCapture : today, sendHello: false)
        case .device:
            guard quickCaptureConfigured else { return CaptureGestureDecision(action: today, sendHello: false) }
            if linked { return CaptureGestureDecision(action: .quickCapture, sendHello: false) }
            return CaptureGestureDecision(action: debug ? .quickCapture : today, sendHello: linkingEnabled)
        }
    }
}
