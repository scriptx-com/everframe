// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// The mode rule: what the capture gesture does on this device.
//
// | Host        | State                                   | Action        | Hello           | Swallow** |
// |-------------|-----------------------------------------|---------------|-----------------|-----------|
// | unsupported | any                                     | no reporter*  | no              | no        |
// | simulator   | quick capture configured, debug build   | quick capture | no              | no        |
// | simulator   | otherwise                               | no reporter*  | no              | no        |
// | device      | quick capture not configured            | no reporter*  | no              | no        |
// | device      | linked                                  | quick capture | no              | yes       |
// | device      | unlinked, debug build                   | quick capture | if linking is on| no        |
// | device      | unlinked, release build                 | no reporter*  | if linking is on| no        |
//
// * "No reporter" is today's shake: `.reporter` for a shake (the reporter
//   opens only when `shakeToReport` allows it) and `.nothing` for the
//   simulator's capture notification and the Siri Remote binding, which never
//   opened the reporter.
// ** `swallowKeys`: only the Siri Remote binding (`.remote`) on a linked
//   device may keep the binding's presses from the app. An unlinked device
//   never swallows a press.
//
// `quickCaptureConfigured` is the local `quickCaptureEnabled` and
// `reporterEnabled` options plus the dashboard's `captureHotkey.enabled`:
// a disabled quick capture means no capture and no hello on any device.
import Foundation

enum CaptureGestureSource: Equatable, Sendable {
    case shake
    /// `notifyutil -p com.everframe.capture` in a simulator.
    case simulatorNotification
    /// The app's TV binding on the Siri Remote (Apple TV).
    case remote
}

enum CaptureGestureAction: Equatable, Sendable {
    case quickCapture, reporter, nothing
}

struct CaptureGestureDecision: Equatable, Sendable {
    let action: CaptureGestureAction
    let sendHello: Bool
    /// Whether the binding's presses may be kept from the app. Only true for
    /// `.remote` on a linked device.
    let swallowKeys: Bool

    init(action: CaptureGestureAction, sendHello: Bool, swallowKeys: Bool = false) {
        self.action = action
        self.sendHello = sendHello
        self.swallowKeys = swallowKeys
    }
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
            if linked {
                return CaptureGestureDecision(action: .quickCapture, sendHello: false, swallowKeys: source == .remote)
            }
            return CaptureGestureDecision(action: debug ? .quickCapture : today, sendHello: linkingEnabled)
        }
    }
}
