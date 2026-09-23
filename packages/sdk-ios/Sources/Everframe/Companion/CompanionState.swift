// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Phase 06.2-07 — Companion runtime state surface.
//
// `CompanionState` is the host-visible state machine for the phone-companion
// pairing flow (SPEC Req 3). Transitions are driven by the relay-WS client
// and the capture bridge; hosts observe via:
//   1. Combine `@Published` on `Everframe.shared.companion.state` (preferred for
//      SwiftUI / Combine consumers).
//   2. NotificationCenter via `.everframeCompanionStateChange` (UIKit-only hosts
//      or Objective-C bridges).
//
// Mirrors the dual-surface pattern locked for `ReportAPI.isPresenting` in
// `Everframe.swift:236-279` (Phase 05.1).
//
// File-ownership timeline:
//   • 06.2-07 — initial CompanionState + Notification.Name extensions.
import Foundation

/// State machine for the phone-companion reporter flow.
///
/// - `.unpaired`: TV is connected to relay but no phone is bonded; `pairUrl`
///   is populated and the host should render a QR.
/// - `.paired`: A phone has bonded to this TV; the host renders a "phone
///   connected" indicator (chrome is host-rendered, not Everframe SDK-shipped).
/// - `.reportInProgress`: Phone is actively assembling/editing a report; TV
///   is mid-capture or relaying draft updates.
/// - `.phoneDisconnected`: Transient — phone lost connection but the pair
///   record still holds (within the 5-minute reconnect grace window).
public enum CompanionState: String, Sendable, CaseIterable {
    case unpaired
    case paired
    case reportInProgress
    case phoneDisconnected
}

public extension Notification.Name {
    /// Posted on every flip of `Everframe.shared.companion.state`. userInfo:
    /// `["state": CompanionState.rawValue]` (String). Non-Combine consumers
    /// (UIKit-only hosts, Objective-C bridges) subscribe via NotificationCenter.
    static let everframeCompanionStateChange =
        Notification.Name("dev.everframe.companionStateChange")

    /// Posted on every flip of `Everframe.shared.companion.pairUrl`. userInfo:
    /// `["pairUrl": String?]` (NSNull when nil to round-trip through userInfo).
    static let everframeCompanionPairUrlChange =
        Notification.Name("dev.everframe.companionPairUrlChange")

    /// Posted on every flip of `Everframe.shared.companion.code` — the short
    /// display code from `/api/companion/announce` (spec 2026-08-07).
    /// userInfo: `["code": String?]` (NSNull when nil to round-trip through
    /// userInfo).
    static let everframeCompanionCodeChange =
        Notification.Name("dev.everframe.companionCodeChange")

    /// Posted on every flip of `Everframe.shared.companion.attachedUserName` —
    /// the dashboard user who attached to this device, nil on an ordinary QR
    /// bond. userInfo: `["attachedUserName": String?]` (NSNull when nil).
    static let everframeCompanionAttachedUserNameChange =
        Notification.Name("dev.everframe.companionAttachedUserNameChange")

    /// Posted on every flip of `Everframe.shared.companion.resolvedName` — the
    /// announce-resolved display name (spec 2026-08-24): custom rename ->
    /// host label -> server-composed default, updated live by `companion.name`
    /// pushes. userInfo: `["resolvedName": String?]` (NSNull when nil).
    static let everframeCompanionResolvedNameChange =
        Notification.Name("dev.everframe.companionResolvedNameChange")

    /// Posted on every flip of `Everframe.shared.companion.attachChallenge`
    /// (spec 2026-08-19) — the relay's `attach.challenge` push when a
    /// dashboard member requests attach, cleared by `attach.challenge.cleared`
    /// (reasons: expired|attached|burned|superseded) or a terminal pair close.
    /// userInfo: `["code": String, "requestedByName": String, "ttlMs": Int]`
    /// on set, `[:]` on clear.
    static let everframeCompanionAttachChallengeChange =
        Notification.Name("dev.everframe.companionAttachChallengeChange")
}
