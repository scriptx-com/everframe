// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// CONFIG-02 parity — fail-closed remote per-app session-replay config provider.
// Direct port of sdk-core/src/types/replay/config-provider.ts.
//
// Contract (mirrors config-provider.ts verbatim):
//   - `GET <IngestEndpoint.url>/api/config` authed by the Bearer Everframe SDK key (exactly
//     like /api/ingest), Accept: application/json.
//   - Response is strictly decoded both ends: { replayEnabled, replayDurationSec,
//     samplingRate }. samplingRate is bounded to [0,1].
//   - Default object is OFF; overwritten ONLY by a fully decoded valid 200.
//   - FAIL CLOSED on every error path: network rejection / non-200 / malformed body /
//     missing/wrong-typed field / out-of-range samplingRate / timeout. On any failure
//     the cache keeps its current value and `refresh()` resolves silently (never throws).
//     An error never flips ON → OFF mid-session — only a validated response mutates.
//   - TTL 5 min; refresh is a no-op within the window; refetches after expiry.
//   - `samplingRate` is surfaced verbatim for the lifecycle sampling gate (CONFIG-04).
import Foundation

// Mirrors the server's BreadcrumbsBlockSchema (the server configuration contract);
// parity fixture: packages/protocol/__tests__/fixtures/breadcrumbs-config-parity.v1.json.
public struct BreadcrumbsConfigWire: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public let kinds: [String]
    public let maxCount: Int
    public let byteBudget: Int
    public let consoleEntryCap: Int
}

// Mirrors the server's NetworkBodiesConfigSchema — network body capture config
// block, decoded leniently (a malformed block degrades to nil, never sinking
// the top-level ReplayConfig decode — see ReplayConfigWire.init(from:)).
//
// Round-2 review Finding F10: the ceilings below mirror the server's
// `NetworkBodiesBlockSchema` (the server configuration contract)
// and are enforced HERE, in `init(from:)`, rather than left to whoever later
// consumes these values. Without this, `bodyByteCap: Int.max` would sail
// through decode and later overflow `cap + secretScanOverlap` in
// `NetworkBodyCapture` — TRAPping the host process — and a negative cap would
// corrupt the truncation-window math (can return a WIDENED window instead of
// a narrower one). Throwing here degrades the whole block to `nil` via the
// existing `try? decodeIfPresent` in `ReplayConfigWire.init(from:)`
// (fail-closed: no bodies captured), while leaving the top-level config
// decode (replayEnabled/replayDurationSec/samplingRate/breadcrumbs) unaffected.
public struct NetworkBodiesConfigWire: Decodable, Sendable, Equatable {
    public let captureBodies: Bool
    public let bodyByteCap: Int?
    public let bodyContentTypes: [String]?
    public let bodyTotalBudget: Int?

    /// 1...65536 — mirrors `bodyByteCap: z.number().int().positive().max(65536)`.
    static let bodyByteCapRange = 1...65_536
    /// 1...1_048_576 (1 MiB) — mirrors `bodyTotalBudget: z.number().int().positive().max(1048576)`.
    static let bodyTotalBudgetRange = 1...1_048_576
    /// 1...16 entries — mirrors `bodyContentTypes: z.array(...).min(1).max(16)`.
    static let bodyContentTypesCountRange = 1...16
    /// 1...64 chars per entry — mirrors `z.string().min(1).max(64)`.
    static let bodyContentTypeLengthRange = 1...64

    enum CodingKeys: String, CodingKey {
        case captureBodies, bodyByteCap, bodyContentTypes, bodyTotalBudget
    }

    /// Explicit memberwise init — the custom `init(from:)` below (needed for
    /// wire-limit validation) suppresses Swift's synthesized memberwise
    /// initializer, but test call sites (and any other in-process
    /// constructor) still need one. Intentionally does NOT re-run the wire
    /// validation above: in-process callers are trusted; only bytes off the
    /// wire need the fail-closed check.
    public init(
        captureBodies: Bool,
        bodyByteCap: Int?,
        bodyContentTypes: [String]?,
        bodyTotalBudget: Int?
    ) {
        self.captureBodies = captureBodies
        self.bodyByteCap = bodyByteCap
        self.bodyContentTypes = bodyContentTypes
        self.bodyTotalBudget = bodyTotalBudget
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        captureBodies = try c.decode(Bool.self, forKey: .captureBodies)

        let byteCap = try c.decodeIfPresent(Int.self, forKey: .bodyByteCap)
        if let byteCap, !Self.bodyByteCapRange.contains(byteCap) {
            throw DecodingError.dataCorruptedError(
                forKey: .bodyByteCap, in: c,
                debugDescription: "bodyByteCap \(byteCap) outside \(Self.bodyByteCapRange) — fail closed"
            )
        }
        bodyByteCap = byteCap

        let totalBudget = try c.decodeIfPresent(Int.self, forKey: .bodyTotalBudget)
        if let totalBudget, !Self.bodyTotalBudgetRange.contains(totalBudget) {
            throw DecodingError.dataCorruptedError(
                forKey: .bodyTotalBudget, in: c,
                debugDescription: "bodyTotalBudget \(totalBudget) outside \(Self.bodyTotalBudgetRange) — fail closed"
            )
        }
        bodyTotalBudget = totalBudget

        let contentTypes = try c.decodeIfPresent([String].self, forKey: .bodyContentTypes)
        if let contentTypes {
            guard Self.bodyContentTypesCountRange.contains(contentTypes.count) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .bodyContentTypes, in: c,
                    debugDescription:
                        "bodyContentTypes has \(contentTypes.count) entries, outside \(Self.bodyContentTypesCountRange) — fail closed"
                )
            }
            guard contentTypes.allSatisfy({ Self.bodyContentTypeLengthRange.contains($0.count) }) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .bodyContentTypes, in: c,
                    debugDescription:
                        "bodyContentTypes entry length outside \(Self.bodyContentTypeLengthRange) — fail closed"
                )
            }
        }
        bodyContentTypes = contentTypes
    }
}

// Mirrors the server's identity block (recognition spec 2026-08-06). Present
// only when the project has a signing secret AND this Everframe SDK declared the
// `identity` capability in `X-Everframe-SDK-Features` — see `sdkFeaturesHeaderValue`.
public struct IdentityConfigWire: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
}

/// Report EverframeResource Window (spec 2026-09-05). Mirrors the server's
/// `ReplayConfigResponseSchema.resources` block (the ingest API's config-route.ts):
/// `{ enabled, windowSec }`. Present only when this Everframe SDK declares `resources`
/// in `X-Everframe-SDK-Features` — same capability-negotiation doctrine as
/// `identity`/`companionBadge`/`branding` above. Without declaring the token
/// the server never emits this block at all, and the feature is silently,
/// permanently off (the negotiation-gap this Everframe SDK closes).
///
/// `windowSec` carries its OWN field-level leniency (mirrors sdk-core's
/// `ResourcesServerConfig`, whose `windowSec` is `.positive().optional()
/// .catch(undefined)`): a malformed or non-positive window length alone
/// degrades to `nil` — the caller (`ReplaySession.applyConfig`) then falls
/// back to `ResourceRingBuffer.defaultWindowSec` — WITHOUT losing `enabled`,
/// so a server-side typo on the window length doesn't also blank the
/// on/off signal. `enabled` itself is required (matches the server's
/// non-optional field); a missing/malformed `enabled` fails this whole
/// struct's decode, which the OUTER lenient `(try? ...) ?? nil` in
/// `ReplayConfigWire.init(from:)` degrades to "block absent" (feature off),
/// same posture as companionBadge/networkBodies.
public struct ResourcesConfigWire: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public let windowSec: Int?

    public init(enabled: Bool, windowSec: Int? = nil) {
        self.enabled = enabled
        self.windowSec = windowSec
    }

    enum CodingKeys: String, CodingKey { case enabled, windowSec }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        let raw = (try? c.decodeIfPresent(Int.self, forKey: .windowSec)) ?? nil
        windowSec = (raw.map { $0 > 0 }) == false ? nil : raw
    }
}

/// Native shake-to-report dashboard gate. The outer decoder degrades malformed blocks to nil/off.
public struct ShakeToReportConfigWire: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public init(enabled: Bool) { self.enabled = enabled }
}

/// Server-driven companion name-badge override (plan 2026-08-25). Present
/// only when this Everframe SDK declared `companionbadge` in `X-Everframe-SDK-Features`.
/// `position` stays a STRING here (wire shape); resolution to
/// `CompanionBadgePosition` happens at the badge via
/// `CompanionBadgeResolution.position`, so an unrecognised future position
/// falls back to the inline option rather than a hard-coded corner.
public struct CompanionBadgeConfigWire: Decodable, Sendable, Equatable {
    public let enabled: Bool
    public let position: String?
    public init(enabled: Bool, position: String? = nil) {
        self.enabled = enabled
        self.position = position
    }
}

/// EverframeReporter branding block (iOS spec 2026-08-26). Present only when this Everframe SDK
/// declared `branding` in `X-Everframe-SDK-Features`.
///
/// Decoded FIELD-BY-FIELD leniently, unlike the sibling wire types above:
/// `watermark: false` is the paid-plan entitlement signal, and a bad color
/// (or wrong-typed sibling) must degrade THAT FIELD alone rather than
/// dropping the signal with it — mirroring Android's element-wise
/// BrandingConfigWireSerializer and web's per-field `.catch(undefined)`.
/// Every access is `try?`-guarded, so this init cannot throw in practice;
/// the outer `(try? decodeIfPresent) ?? nil` in ReplayConfigWire remains as
/// defense in depth. `watermark` relies on Swift's type-strict Bool decode:
/// a JSON string "false" degrades to nil (watermarked) — the posture
/// Android's f4d9d3c7 fix added explicitly; a test locks it here.
public struct BrandingThemeWire: Sendable, Equatable {
    public let background: String?
    public let surface: String?
    public let border: String?
    public let text: String?
    public let textMuted: String?
    public let accent: String?
    public let accentForeground: String?
    public let destructive: String?
    public init(
        background: String? = nil, surface: String? = nil, border: String? = nil,
        text: String? = nil, textMuted: String? = nil, accent: String? = nil,
        accentForeground: String? = nil, destructive: String? = nil
    ) {
        self.background = background
        self.surface = surface
        self.border = border
        self.text = text
        self.textMuted = textMuted
        self.accent = accent
        self.accentForeground = accentForeground
        self.destructive = destructive
    }
}

public struct BrandingConfigWire: Decodable, Sendable, Equatable {
    public let watermark: Bool?
    public let theme: BrandingThemeWire?

    public init(watermark: Bool? = nil, theme: BrandingThemeWire? = nil) {
        self.watermark = watermark
        self.theme = theme
    }

    enum CodingKeys: String, CodingKey { case watermark, theme }
    enum ThemeKeys: String, CodingKey {
        case background, surface, border, text, textMuted, accent, accentForeground, destructive
    }

    /// A strict WHOLE-STRING check matching the server's `^#[0-9a-fA-F]{6}$` —
    /// the same gate it enforces at emission and the resolver re-checks
    /// (defense in depth: these strings become colors in the reporter UI).
    ///
    /// Deliberately NOT a regex: `.regularExpression`'s `$` anchor can match
    /// just before a single trailing line terminator rather than strict
    /// end-of-string (ICU regex semantics), so a value with an embedded
    /// trailing newline (`"#336699\n"`) can pass a `^...$`-anchored regex
    /// check that looks equivalent to the server's gate but isn't. A
    /// character-class walk has no anchor semantics to get wrong: it is
    /// exactly "7 chars, `#` then 6 ASCII hex digits," full stop.
    /// `isASCII && isHexDigit` (rather than `isHexDigit` alone) also excludes
    /// non-ASCII fullwidth hex-digit code points that `isHexDigit` alone
    /// would admit.
    static func isValidHex(_ v: String) -> Bool {
        v.count == 7 && v.hasPrefix("#") && v.dropFirst().allSatisfy { $0.isASCII && $0.isHexDigit }
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        watermark = (try? c.decodeIfPresent(Bool.self, forKey: .watermark)) ?? nil
        if let t = try? c.nestedContainer(keyedBy: ThemeKeys.self, forKey: .theme) {
            func hex(_ key: ThemeKeys) -> String? {
                guard let v = (try? t.decodeIfPresent(String.self, forKey: key)) ?? nil else { return nil }
                return Self.isValidHex(v) ? v : nil
            }
            theme = BrandingThemeWire(
                background: hex(.background), surface: hex(.surface), border: hex(.border),
                text: hex(.text), textMuted: hex(.textMuted), accent: hex(.accent),
                accentForeground: hex(.accentForeground), destructive: hex(.destructive)
            )
        } else {
            theme = nil
        }
    }
}

public struct ReplayConfig: Sendable, Equatable {
    public let nativeVideo: NativeVideoSettings?
    public let replayEnabled: Bool
    public let replayDurationSec: Int
    public let samplingRate: Double
    public let breadcrumbs: BreadcrumbsConfigWire?
    public let networkBodies: NetworkBodiesConfigWire?
    public let identity: IdentityConfigWire?
    public let companionBadge: CompanionBadgeConfigWire?
    public let branding: BrandingConfigWire?
    public let resources: ResourcesConfigWire?
    public let shakeToReport: ShakeToReportConfigWire?
    /// Session Vitals (iOS spec 2026-09-05 §1). `nil` per-field means "no
    /// server opinion" — see `toVitalsServerConfig()`'s defaulting.
    public let vitalsEnabled: Bool?
    public let vitalsSampleRate: Double?

    public init(
        replayEnabled: Bool,
        replayDurationSec: Int,
        samplingRate: Double,
        breadcrumbs: BreadcrumbsConfigWire? = nil,
        networkBodies: NetworkBodiesConfigWire? = nil,
        identity: IdentityConfigWire? = nil,
        companionBadge: CompanionBadgeConfigWire? = nil,
        branding: BrandingConfigWire? = nil,
        resources: ResourcesConfigWire? = nil,
        shakeToReport: ShakeToReportConfigWire? = nil,
        nativeVideo: NativeVideoSettings? = NativeVideoSettings(),
        vitalsEnabled: Bool? = nil,
        vitalsSampleRate: Double? = nil
    ) {
        self.replayEnabled = replayEnabled
        self.replayDurationSec = replayDurationSec
        self.samplingRate = samplingRate
        self.breadcrumbs = breadcrumbs
        self.networkBodies = networkBodies
        self.identity = identity
        self.companionBadge = companionBadge
        self.branding = branding
        self.resources = resources
        self.shakeToReport = shakeToReport
        self.nativeVideo = nativeVideo
        self.vitalsEnabled = vitalsEnabled
        self.vitalsSampleRate = vitalsSampleRate
    }

    /// The canonical OFF default (REPLAY_CONFIG_OFF). Returned until the first fully
    /// validated 200 resolves — and never weakened by any error path.
    public static let off = ReplayConfig(replayEnabled: false, replayDurationSec: 30, samplingRate: 1.0)
}

/// True only when the server says identity is enabled for this project. A
/// project with no signing secret never reaches the customer's endpoint and
/// never presents a header.
public func isIdentityEnabled(_ config: ReplayConfig) -> Bool {
    config.identity?.enabled == true
}

/// Strict wire shape. A bad type / missing field fails `Decodable` → fail closed.
/// An out-of-range `samplingRate` throws in `init(from:)` → fail closed (clamp is
/// NOT acceptable; a hostile rate must never reach the gate).
private struct ReplayConfigWire: Decodable {
    let nativeVideo: NativeVideoSettings?
    let replayEnabled: Bool
    let replayDurationSec: Int
    let samplingRate: Double
    let breadcrumbs: BreadcrumbsConfigWire?
    let networkBodies: NetworkBodiesConfigWire?
    let identity: IdentityConfigWire?
    let companionBadge: CompanionBadgeConfigWire?
    let branding: BrandingConfigWire?
    let resources: ResourcesConfigWire?
    let shakeToReport: ShakeToReportConfigWire?
    let vitalsEnabled: Bool?
    let vitalsSampleRate: Double?

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nativeVideo = c.contains(.nativeVideo)
            ? (try? c.decode(NativeVideoSettings.self, forKey: .nativeVideo))
            : NativeVideoSettings()
        replayEnabled = try c.decode(Bool.self, forKey: .replayEnabled)
        replayDurationSec = try c.decode(Int.self, forKey: .replayDurationSec)
        let rate = try c.decode(Double.self, forKey: .samplingRate)
        guard rate >= 0, rate <= 1 else {
            throw DecodingError.dataCorruptedError(
                forKey: .samplingRate,
                in: c,
                debugDescription: "samplingRate \(rate) out of [0,1] — fail closed"
            )
        }
        samplingRate = rate
        breadcrumbs = try c.decodeIfPresent(BreadcrumbsConfigWire.self, forKey: .breadcrumbs)
        // Lenient nested decode — a malformed networkBodies block degrades to
        // nil (capture off) rather than sinking the whole config decode.
        networkBodies = (try? c.decodeIfPresent(NetworkBodiesConfigWire.self, forKey: .networkBodies)) ?? nil
        identity = try c.decodeIfPresent(IdentityConfigWire.self, forKey: .identity)
        // Lenient nested decode, same posture as networkBodies above: a
        // malformed companionBadge block degrades to nil (the Everframe SDK keeps its
        // inline/default badge) rather than sinking the whole config decode.
        companionBadge = (try? c.decodeIfPresent(CompanionBadgeConfigWire.self, forKey: .companionBadge)) ?? nil
        // Lenient nested decode, same posture as companionBadge above; the
        // block's own init(from:) is additionally per-field lenient — see
        // BrandingConfigWire's doc comment.
        branding = (try? c.decodeIfPresent(BrandingConfigWire.self, forKey: .branding)) ?? nil
        // Lenient nested decode, same posture as companionBadge/networkBodies
        // above: a malformed resources block degrades to nil (feature off)
        // rather than sinking the whole config decode. The block's own
        // init(from:) is additionally per-field lenient for `windowSec` —
        // see ResourcesConfigWire's doc comment.
        resources = (try? c.decodeIfPresent(ResourcesConfigWire.self, forKey: .resources)) ?? nil
        shakeToReport = (try? c.decodeIfPresent(ShakeToReportConfigWire.self, forKey: .shakeToReport)) ?? nil
        // Session Vitals (iOS spec 2026-09-05 §1) — per-field lenient, the
        // branding block's posture: a wrong-typed field degrades THAT FIELD
        // alone. Clamping to [0,1] happens in toVitalsServerConfig().
        vitalsEnabled = (try? c.decodeIfPresent(Bool.self, forKey: .vitalsEnabled)) ?? nil
        vitalsSampleRate = (try? c.decodeIfPresent(Double.self, forKey: .vitalsSampleRate)) ?? nil
    }

    enum CodingKeys: String, CodingKey {
        case replayEnabled, replayDurationSec, samplingRate, breadcrumbs, networkBodies, identity
        case companionBadge, branding, nativeVideo, vitalsEnabled, vitalsSampleRate
        case resources, shakeToReport
    }

    var config: ReplayConfig {
        ReplayConfig(
            replayEnabled: replayEnabled,
            replayDurationSec: replayDurationSec,
            samplingRate: samplingRate,
            breadcrumbs: breadcrumbs,
            networkBodies: networkBodies,
            identity: identity,
            companionBadge: companionBadge,
            branding: branding,
            resources: resources,
            shakeToReport: shakeToReport,
            nativeVideo: nativeVideo,
            vitalsEnabled: vitalsEnabled,
            vitalsSampleRate: vitalsSampleRate
        )
    }
}

/// Injectable transport so specs drive every error path deterministically (no real
/// network). `URLSession` conforms by default below.
public protocol URLSessionFetching: Sendable {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

extension URLSession: URLSessionFetching {}

/// 5-minute TTL (mirrors DEFAULT_CONFIG_TTL_MS = 300_000ms). Expressed in seconds
/// because the injected clock is `TimeInterval` (seconds, matching the lifecycle's
/// `ProcessInfo.systemUptime` origin).
public let defaultConfigTtlSec: TimeInterval = 300

/// Fail-closed session-replay config provider. Modeled as an `actor` so the cache +
/// last-fetch timestamp mutate safely under StrictConcurrency.
public actor ReplayConfigProvider {
    private let configUrl: URL
    /// Resolved on EVERY fetch, not once at construction (Plan 2b-i). Plan
    /// 2b-ii puts a per-UTC-day gate behind this, which only works if the
    /// value is re-asked for each time — the web Everframe SDK baked its identifier into
    /// the stored URL in Plan 2a and needs a retrofit for exactly this reason.
    /// Returning nil means "send the config URL unchanged"; it is never an
    /// error, and this closure must never throw or block.
    private let installIdProvider: @Sendable () -> String?
    private let apiKey: String
    private let fetcher: URLSessionFetching
    private let ttlSec: TimeInterval
    private let now: @Sendable () -> TimeInterval

    /// Starts OFF. The ONLY mutation path is a fully decoded valid 200.
    private var cache: ReplayConfig = .off
    private var lastFetchedAt: TimeInterval?

    /// F32 (round-7 review, P1) — `actor` isolation serializes each METHOD
    /// BODY's synchronous stretches, but it does NOT serialize completion
    /// order across `await` suspension points: two overlapping calls to
    /// `refresh()` (e.g. `ReplaySession`'s initial fetch racing its own
    /// first periodic-loop tick, or two direct callers) can each pass the
    /// TTL check, each `await fetcher.data(for:)`, and then resume in
    /// EITHER order. Before this fix, whichever resolved LAST simply
    /// overwrote `cache` — an older-started request (e.g. stale
    /// `captureBodies: true`) resolving after a newer one (e.g. a
    /// just-flipped `captureBodies: false` kill switch) silently undid it.
    ///
    /// Fixed exactly like sdk-core's `config-provider.ts` (same PR, same
    /// finding): a monotonically increasing request-sequence number stamped
    /// synchronously, before the first `await`, when a real fetch attempt
    /// begins (never on a TTL no-op). `latestStartedSeq` always holds the
    /// highest sequence number among all attempts started so far — a
    /// response commits to `cache` ONLY if no newer request has begun since
    /// this one started, so only the LATEST-STARTED request can ever win,
    /// regardless of completion order. A superseded response returns
    /// `false` rather than `true`, so `ReplaySession.refreshConfigNow()`
    /// never mistakes it for a fresh, confirmed read (it already applies a
    /// nil server block — failing the body gate closed — whenever `refresh`
    /// reports `false`, so this composes for free with that existing
    /// Finding-5 posture).
    private var requestSeq = 0
    private var latestStartedSeq = 0

    public init(
        configUrl: URL,
        apiKey: String,
        fetcher: URLSessionFetching = URLSession.shared,
        ttlSec: TimeInterval = defaultConfigTtlSec,
        now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
        installIdProvider: @escaping @Sendable () -> String? = { nil }
    ) {
        self.configUrl = configUrl
        self.apiKey = apiKey
        self.fetcher = fetcher
        self.ttlSec = ttlSec
        self.now = now
        self.installIdProvider = installIdProvider
    }

    /// Convenience: build the provider from the base ingest endpoint by appending
    /// `/api/config` (mirrors MultipartUploader's base-URL path-append).
    public static func make(
        baseURL: URL = IngestEndpoint.url,
        apiKey: String,
        fetcher: URLSessionFetching = URLSession.shared,
        installIdProvider: @escaping @Sendable () -> String? = { nil }
    ) -> ReplayConfigProvider {
        ReplayConfigProvider(
            configUrl: configURL(from: baseURL),
            apiKey: apiKey,
            fetcher: fetcher,
            installIdProvider: installIdProvider
        )
    }

    /// Append `/api/config` to a base URL, tolerating an already-suffixed endpoint
    /// (custom routing / reverse proxy) — mirrors MultipartUploader.ingestURL.
    static func configURL(from baseURL: URL) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        let basePath = (components?.path ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if basePath.hasSuffix("api/config") {
            return baseURL
        }
        components?.path = "/" + (basePath.isEmpty ? "api/config" : "\(basePath)/api/config")
        return components?.url ?? baseURL
    }

    /// `configUrl` plus `?installId=<value>` when the supplier has one. Any
    /// failure — nil, empty, or a URL that will not re-compose — yields the
    /// unmodified `configUrl`, never a throw: this is the kill-switch read.
    /// The identifier is unreserved base64url so percent-encoding is a no-op,
    /// but `URLQueryItem` is used anyway rather than string concatenation, so
    /// a future non-base64url value cannot silently produce a malformed URL.
    private func requestURL() -> URL {
        guard let installId = installIdProvider(), !installId.isEmpty else { return configUrl }
        guard var components = URLComponents(url: configUrl, resolvingAgainstBaseURL: false) else {
            return configUrl
        }
        var items = components.queryItems ?? []
        items.append(URLQueryItem(name: "installId", value: installId))
        components.queryItems = items
        return components.url ?? configUrl
    }

    /// The in-memory cache. OFF until the first validated success — never throws.
    public var current: ReplayConfig {
        cache
    }

    /// Fetches `GET /api/config`, strictly decodes, and overwrites the cache ONLY on
    /// full validation. Any error path keeps the cache and resolves silently (fail
    /// closed). A no-op within the TTL window, UNLESS `force` is set.
    ///
    /// Final-review Findings 4/5 (2026-08-01-network-body-capture-native):
    ///   - `force: true` bypasses the TTL check (still records `lastFetchedAt`)
    ///     so a caller that itself runs on a TTL-matched cadence (the
    ///     `ReplaySession` periodic loop) doesn't race its own gate — see that
    ///     file's `startPeriodicRefreshLoop()` for why an unforced call there
    ///     was silently halving the effective poll rate.
    ///   - Return value (`@discardableResult` so existing unforced call sites
    ///     that ignore it keep compiling) reports whether THIS invocation can
    ///     be trusted as reflecting a live, current config: `true` on a fully
    ///     decoded valid 200, OR a non-forced TTL-skip (the cache is still
    ///     fresh by definition); `false` when an actual fetch was attempted
    ///     and failed (network error, non-200, decode failure) — even though
    ///     the cache itself silently keeps its last-good value per the
    ///     fail-closed contract above. Callers that need to distinguish
    ///     "confirmed current" from "stale cache, fetch just failed" (e.g.
    ///     the network-body gate, which must not stay latched ON forever off
    ///     an unreachable config) use this return value rather than `current`.
    @discardableResult
    public func refresh(force: Bool = false) async -> Bool {
        // No-op within the TTL window once we have fetched at least once —
        // unless the caller forces a bypass. A TTL-skip is not a failure: the
        // cache is still fresh, so this reports success.
        if !force, let last = lastFetchedAt, now() - last < ttlSec {
            return true
        }
        // F32: stamp this attempt with the next sequence number BEFORE the
        // first `await` below, so "which request started last" is
        // determined by call order, not by however the two overlapping
        // fetches happen to interleave/resolve.
        requestSeq += 1
        let mySeq = requestSeq
        latestStartedSeq = mySeq
        defer {
            // Mark the attempt so TTL windowing advances even on failure.
            lastFetchedAt = now()
        }
        do {
            var req = URLRequest(url: requestURL())
            req.httpMethod = "GET"
            req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
            req.setValue("application/json", forHTTPHeaderField: "Accept")
            // Declares client support for the networkBodies + identity config
            // blocks so the server can gate each feature on capability rather
            // than version.
            req.setValue(Self.sdkFeaturesHeaderValue, forHTTPHeaderField: "X-Everframe-SDK-Features")
            // Bound the request so a hung fetch cannot wedge the provider.
            req.timeoutInterval = ttlSec

            let (data, response) = try await fetcher.data(for: req)
            // Non-200 ⇒ fail closed (keep current cache).
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                return false
            }
            // Malformed JSON / missing field / wrong type / out-of-range ⇒ throws ⇒
            // caught below ⇒ fail closed.
            let wire = try JSONDecoder().decode(ReplayConfigWire.self, from: data)
            // F32: an older-started request must never overwrite a newer
            // one, even if it resolves after the newer one already started
            // (or already committed). Discard silently — the same
            // fail-closed-on-THIS-read posture as any other failure path
            // below, from the caller's point of view.
            guard mySeq == latestStartedSeq else {
                return false
            }
            // The ONLY path that mutates the cache: a fully decoded valid 200.
            cache = wire.config
            return true
        } catch {
            // network rejection / timeout / decode failure ⇒ fail closed silently.
            // cache stays at its current value (last-good or OFF). Never re-throw.
            return false
        }
    }
}

extension ReplayConfigProvider {
    /// Capability tokens sent as `X-Everframe-SDK-Features`. The server returns a
    /// config block ONLY for capabilities the caller declares
    /// (the server configuration contract) — so adding a block here is a
    /// prerequisite for receiving it, not a formality.
    public static let sdkFeaturesHeaderValue =
        "networkbodies, identity, companionbadge, branding, nativevideo, vitals, resources, shaketoreport"

    /// Test seam: decode a raw `/api/config` body exactly as `refresh()` does.
    static func __decodeForTesting(_ data: Data) throws -> ReplayConfig {
        try JSONDecoder().decode(ReplayConfigWire.self, from: data).config
    }
}
