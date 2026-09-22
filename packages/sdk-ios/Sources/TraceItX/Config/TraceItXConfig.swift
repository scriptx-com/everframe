// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Public config types for TraceItX. Field set sourced from RESEARCH Finding 14
// (Phase 4) and trimmed in Phase 05.1 to remove host-UX trigger config (TV keys
// and bubbles). Native mobile shake-to-report is the narrow exception.
import Foundation

// MARK: - Config

/// `Equatable` (codex round-7, I3) so a repeat `configure()` can ask the ONE question that
/// matters — "is the SDK already running exactly this?" — against the whole config rather
/// than a hand-maintained rendering of the fields one caller happens to set. The RN bridge
/// used to compare a string snapshot it built itself, which silently answered "unchanged"
/// for any field the snapshot's author had not thought to include; a synthesized `==` covers
/// every stored property by construction and keeps covering new ones. `RedactionConfig`
/// supplies the one hand-written `==` (see its own note).
public struct TraceItXConfig: Sendable, Equatable {
    public let appId: String
    public let environment: Environment
    public let release: String?
    public var capture: CaptureConfig
    public var redaction: RedactionConfig
    /// Explicit companion device-identity override (naming spec 2026-08-24) —
    /// an MDM id or provisioning serial the host already knows, hashed
    /// (SHA-256 → UUID shape) before it ever reaches the announce `device`
    /// block; see `CompanionDeviceId.resolve`. `nil` (the default) falls
    /// through to the Keychain-then-stored-UUID chain. Mirrors Android's
    /// `TraceItXConfig.companionDeviceId`.
    public var companionDeviceId: String?
    /// Companion on-screen name-badge visibility toggle (naming spec
    /// 2026-08-24, controller ruling / Task 6b) — lets a host that finds
    /// the badge intrusive turn it off in one line. Defaults to `true`
    /// (badge shown), matching `CompanionBadgeOptions.enabled`'s own
    /// default. Flat `Bool`, not `CompanionBadgeOptions` itself — mirrors
    /// `companionDeviceId` above staying a flat wire-shaped field rather
    /// than a richer type. Mirrors Android's
    /// `TraceItXConfig.companionBadgeEnabled`.
    public var companionBadgeEnabled: Bool
    /// Local veto for native mobile shake-to-report. Dashboard disablement always wins.
    public var shakeToReportEnabled: Bool
    /// Companion on-screen name-badge corner (naming spec 2026-08-24,
    /// controller ruling / Task 6b) — raw string mirroring
    /// `CompanionBadgePosition`'s four cases ('bottom-right' |
    /// 'bottom-left' | 'top-right' | 'top-left'). `nil` or an unrecognised
    /// value falls through to `.bottomRight` — see
    /// `TraceItXBridge.parseCompanionBadgePosition`. Mirrors Android's
    /// `TraceItXConfig.companionBadgePosition`.
    public var companionBadgePosition: String?
    /// Inline reporter theme (branding spec 2026-08-26) — 8 semantic color
    /// roles, #rrggbb strings only, exact web/Android names (see
    /// ReporterThemeOptions). Applies ONLY once the server confirms a paid
    /// plan (the /api/config branding block says watermark: false);
    /// per-field precedence is server theme → this inline theme → default.
    /// Read by TXReporterPresenter via `TraceItX.shared.currentConfig`.
    /// Mirrors Android's `TraceItXConfig.theme`.
    public var theme: ReporterThemeOptions?

    /// Install-identifier client control (MAI meter spec 2026-08-27). ON by
    /// default: the SDK sends a value derived from a locally-minted,
    /// non-secret per-install seed at most once a day, so distinct installs
    /// can be counted toward your plan. Nothing about the person using the
    /// app is derived or stored, and the seed itself never leaves the device.
    ///
    /// CLIENT VETO only — `false` turns it off locally from that point on; it
    /// can never force it on. Flat `Bool` rather than web's nested
    /// `{ disabled }`, matching this platform's existing veto idiom
    /// (`capture.networkBodies`, `companionBadgeEnabled`). Mirrors Android's
    /// `TraceItXConfig.installIdentifierEnabled`.
    ///
    /// NOT retroactive and NOT org-wide: installs already recorded earlier in
    /// the calendar month stay counted, and the number shown is per
    /// ORGANIZATION — another app in the same org that still sends one keeps
    /// contributing.
    public var installIdentifierEnabled: Bool
    /// Session Vitals local controls (iOS spec 2026-09-05 §1). See
    /// `VitalsConfig`'s own doc for the opt-out-only posture.
    public var vitals: VitalsConfig

    public enum Environment: Sendable, Equatable {
        case development
        case staging
        case production
    }

    public init(
        appId: String,
        environment: Environment = .production,
        release: String? = nil,
        capture: CaptureConfig = .defaults,
        redaction: RedactionConfig = .defaults,
        companionDeviceId: String? = nil,
        companionBadgeEnabled: Bool = true,
        shakeToReportEnabled: Bool = true,
        companionBadgePosition: String? = nil,
        theme: ReporterThemeOptions? = nil,
        installIdentifierEnabled: Bool = true,
        vitals: VitalsConfig = VitalsConfig()
    ) {
        self.appId = appId
        self.environment = environment
        self.release = release
        self.capture = capture
        self.redaction = redaction
        self.companionDeviceId = companionDeviceId
        self.companionBadgeEnabled = companionBadgeEnabled
        self.shakeToReportEnabled = shakeToReportEnabled
        self.companionBadgePosition = companionBadgePosition
        self.theme = theme
        self.installIdentifierEnabled = installIdentifierEnabled
        self.vitals = vitals
    }
}

public struct CaptureConfig: Sendable, Equatable {
    public var screenshot: Bool
    public var focus: Bool
    public var logs: Bool
    public var network: Bool
    /// Automatic crash reporting (spec 2026-07-18). Default ON — deliberate
    /// contrast with `network` (the payload is already-captured, redacted data;
    /// what changes is that reports ship without user action).
    public var crash: Bool
    public var ringBufferCapacity: Int
    /// Client veto for server-authoritative network-body capture
    /// (network-body-capture spec). `false` vetoes body capture regardless
    /// of server config; `true` never forces it on — the server's
    /// `captureBodies` block + sampling gate must still say ON.
    public var networkBodies: Bool

    public init(
        screenshot: Bool = true,
        focus: Bool = true,
        logs: Bool = true,
        network: Bool = false,
        crash: Bool = true,
        ringBufferCapacity: Int = 250,
        networkBodies: Bool = true
    ) {
        self.screenshot = screenshot
        self.focus = focus
        self.logs = logs
        self.network = network
        self.crash = crash
        self.ringBufferCapacity = ringBufferCapacity
        self.networkBodies = networkBodies
    }

    public static let defaults = CaptureConfig()
}

public struct RedactionConfig: Sendable, Equatable {
    public var defaultDeny: Bool
    public var allowlistedHeaders: Set<String>
    public var customPatterns: [NSRegularExpression]

    public init(
        defaultDeny: Bool = true,
        allowlistedHeaders: Set<String> = [
            "Content-Type", "Content-Length", "Cache-Control",
            "X-Request-ID", "X-Trace-ID", "X-Correlation-ID",
        ],
        customPatterns: [NSRegularExpression] = []
    ) {
        self.defaultDeny = defaultDeny
        self.allowlistedHeaders = allowlistedHeaders
        self.customPatterns = customPatterns
    }

    public static let defaults = RedactionConfig()

    /// Hand-written because `NSRegularExpression` is a CLASS whose `==` is identity: two
    /// instances compiled from the same pattern and options are never equal to each other, so
    /// a synthesized `==` here would report every config as changed and defeat the whole
    /// idempotence gate. Compare what actually defines a pattern — its source string and its
    /// options — pairwise and in order, which is also the only part of it a host can set.
    public static func == (lhs: RedactionConfig, rhs: RedactionConfig) -> Bool {
        guard lhs.defaultDeny == rhs.defaultDeny,
              lhs.allowlistedHeaders == rhs.allowlistedHeaders,
              lhs.customPatterns.count == rhs.customPatterns.count else { return false }
        for (l, r) in zip(lhs.customPatterns, rhs.customPatterns) {
            if l.pattern != r.pattern || l.options.rawValue != r.options.rawValue { return false }
        }
        return true
    }
}

/// Session Vitals local controls (iOS spec 2026-09-05 §1). Local config can
/// only opt OUT or LOWER the rate — the dashboard toggle is authoritative.
public struct VitalsConfig: Sendable, Equatable {
    /// nil = follow the dashboard toggle; false = opt out locally. `true` never forces it on.
    public var enabled: Bool?
    /// Must be in [0, 1]; min()'d with the server rate. nil = server rate.
    public var sampleRate: Double?
    /// Keep query strings on `source_change.src`. Off: signed CDN URLs carry tokens.
    public var captureSourceQuery: Bool
    public init(enabled: Bool? = nil, sampleRate: Double? = nil, captureSourceQuery: Bool = false) {
        self.enabled = enabled; self.sampleRate = sampleRate; self.captureSourceQuery = captureSourceQuery
    }
}

// MARK: - User

public struct TXUser {
    public let id: String?
    public let email: String?
    public let displayName: String?

    public init(id: String? = nil, email: String? = nil, displayName: String? = nil) {
        self.id = id
        self.email = email
        self.displayName = displayName
    }
}

// MARK: - Result

public enum ReportResult {
    case submitted(reportId: UUID)
    case queued(reportId: UUID)
    case cancelled
}

// MARK: - Errors

public enum TraceItXConfigError: Error, Equatable {
    case missingAppId
    case invalidVitalsSampleRate
}

public enum TraceItXTransportError: Error {
    case networkUnavailable
    case outboxFull(droppedCount: Int)
    case serverError(status: Int)
    case payloadTooLarge(bytes: Int, limit: Int)
}
