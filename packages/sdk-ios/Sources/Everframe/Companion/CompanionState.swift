// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Everframe Companion has been removed. `CompanionState` and the
// notification names stay, deprecated, until the next major so existing apps
// keep compiling. `Everframe.shared.companion.state` is always `.unpaired`
// and none of these notifications is posted any more.
import Foundation

/// State of the removed phone-companion flow. Always `.unpaired`.
@available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
public enum CompanionState: String, Sendable, CaseIterable {
    case unpaired
    case paired
    case reportInProgress
    case phoneDisconnected
}

/// Companion notification names. None of them is posted any more.
public extension Notification.Name {
    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionStateChange =
        Notification.Name("dev.everframe.companionStateChange")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionPairUrlChange =
        Notification.Name("dev.everframe.companionPairUrlChange")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionCodeChange =
        Notification.Name("dev.everframe.companionCodeChange")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionAttachedUserNameChange =
        Notification.Name("dev.everframe.companionAttachedUserNameChange")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionResolvedNameChange =
        Notification.Name("dev.everframe.companionResolvedNameChange")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionAttachChallengeChange =
        Notification.Name("dev.everframe.companionAttachChallengeChange")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionReportRequested =
        Notification.Name("dev.everframe.companionReportRequested")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionReportSubmit =
        Notification.Name("dev.everframe.companionReportSubmit")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionReportSubmitBinary =
        Notification.Name("dev.everframe.companionReportSubmitBinary")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionReportShotBinary =
        Notification.Name("dev.everframe.companionReportShotBinary")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionResetSubmitFraming =
        Notification.Name("dev.everframe.companionResetSubmitFraming")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionReportCompleted =
        Notification.Name("dev.everframe.companionReportCompleted")

    @available(*, deprecated, message: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.")
    static let everframeCompanionReportFailed =
        Notification.Name("dev.everframe.companionReportFailed")
}
