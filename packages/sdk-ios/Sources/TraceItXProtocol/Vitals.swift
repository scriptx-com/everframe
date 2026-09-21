// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Hand-written twins of packages/protocol/src/vitals.ts (iOS spec 2026-09-05 §1).
// Codegen only covers the report envelope, so these are maintained by hand and
// pinned by VitalsFixtureParityTests + vitals-ios-fixture.spec.ts. Every type
// carries the `Vitals` prefix because Generated.swift already owns `Vital`,
// `VitalKind` and `TypeEnum` (the flattened envelope rendering of the union).
import Foundation

// MARK: - JSON value

/// A JSON value for player-event and custom `data`. Codable, Equatable and
/// Sendable, unlike the generated `JSONAny` (a class holding `Any`), which is
/// why the collector works in this type and converts to `JSONAny` only at the
/// envelope stamp (GeneratedMapping.swift).
public indirect enum VitalsJSON: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([VitalsJSON])
    case object([String: VitalsJSON])

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let i = try? c.decode(Int64.self) { self = .int(i); return }
        if let d = try? c.decode(Double.self) { self = .double(d); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([VitalsJSON].self) { self = .array(a); return }
        if let o = try? c.decode([String: VitalsJSON].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "not a JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case let .bool(b): try c.encode(b)
        case let .int(i): try c.encode(i)
        case let .double(d): try c.encode(d)
        case let .string(s): try c.encode(s)
        case let .array(a): try c.encode(a)
        case let .object(o): try c.encode(o)
        }
    }

    /// Numeric view used by the summary accumulator (`ttffMs`, `bitrate`, …).
    /// Strings are NOT coerced — a string-typed number is ignored, as in summary.ts.
    public var numberValue: Double? {
        switch self {
        case let .int(i): return Double(i)
        case let .double(d): return d
        default: return nil
        }
    }
}

// MARK: - Constants

public enum VitalsPlayerEventTypes {
    public static let play = "play"
    public static let pause = "pause"
    public static let seek = "seek"
    public static let bufferStart = "buffer_start"
    public static let bufferEnd = "buffer_end"
    public static let bitrateChange = "bitrate_change"
    public static let rateChange = "rate_change"
    public static let error = "error"
    public static let startup = "startup"
    /// Superseded by `stats` for the SDKs in this repo but still a valid
    /// protocol member — kept in `all` so a third-party integration emitting it
    /// is not treated as a typo (Android codex round-3, Important 4).
    public static let droppedFrames = "dropped_frames"
    public static let sourceChange = "source_change"
    public static let playerAttach = "player_attach"
    public static let playerDetach = "player_detach"
    public static let drm = "drm"
    public static let qualityChange = "quality_change"
    public static let stats = "stats"

    /// The allowlist the controller validates `emit(type:)` against. One typo
    /// in a customer integration would otherwise make ingest reject the WHOLE
    /// chunk (Android codex round-2, Important 9).
    public static let all: Set<String> = [
        play, pause, seek, bufferStart, bufferEnd, bitrateChange, rateChange, error, startup,
        droppedFrames, sourceChange, playerAttach, playerDetach, drm, qualityChange, stats,
    ]
}

public enum VitalsLimits {
    public static let maxEnvelopeVitalsEntries = 400
    public static let maxCustomDataBytes = 2048
    public static let maxPlayerEventDataBytes = 8192
    public static let maxCustomNameLength = 64
    public static let maxPlayerIdLength = 32
    public static let maxPlayerLibraryLength = 32
    public static let maxChunkEntries = 200
    public static let maxSeq = 1_000_000
    public static let int32Max: Int64 = 2_147_483_647
}

// MARK: - Entries

public struct VitalsSample: Codable, Equatable, Sendable {
    public var t: Int64
    public var cpu: Double?
    public var mem: Int64
    public var extras: [String: Double]?
    public init(t: Int64, cpu: Double? = nil, mem: Int64, extras: [String: Double]? = nil) {
        self.t = t; self.cpu = cpu; self.mem = mem; self.extras = extras
    }
}

public struct VitalsPlayerEvent: Codable, Equatable, Sendable {
    public var t: Int64
    public var type: String
    public var playerId: String?
    public var data: [String: VitalsJSON]?
    public var truncated: Bool?
    public init(t: Int64, type: String, playerId: String? = nil, data: [String: VitalsJSON]? = nil, truncated: Bool? = nil) {
        self.t = t; self.type = type; self.playerId = playerId; self.data = data; self.truncated = truncated
    }
}

public struct VitalsCustomEntry: Codable, Equatable, Sendable {
    public var t: Int64
    public var name: String
    public var data: VitalsJSON?
    public var truncated: Bool?
    public var playerId: String?
    public init(t: Int64, name: String, data: VitalsJSON? = nil, truncated: Bool? = nil, playerId: String? = nil) {
        self.t = t; self.name = name; self.data = data; self.truncated = truncated; self.playerId = playerId
    }
}

/// `kind`-discriminated union. Encoding flattens the payload struct and adds
/// `kind`; decoding reads `kind` first. The struct's own synthesized Codable
/// omits nil optionals (matches zod `.optional()`, which rejects null).
public enum VitalsEntry: Codable, Equatable, Sendable {
    case sample(VitalsSample)
    case player(VitalsPlayerEvent)
    case custom(VitalsCustomEntry)

    public var t: Int64 {
        switch self {
        case let .sample(s): return s.t
        case let .player(p): return p.t
        case let .custom(c): return c.t
        }
    }

    private enum KindKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: KindKey.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "sample": self = .sample(try VitalsSample(from: decoder))
        case "player": self = .player(try VitalsPlayerEvent(from: decoder))
        case "custom": self = .custom(try VitalsCustomEntry(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown entry kind \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: KindKey.self)
        switch self {
        case let .sample(s): try c.encode("sample", forKey: .kind); try s.encode(to: encoder)
        case let .player(p): try c.encode("player", forKey: .kind); try p.encode(to: encoder)
        case let .custom(x): try c.encode("custom", forKey: .kind); try x.encode(to: encoder)
        }
    }
}

// MARK: - Payloads

public struct VitalsChunk: Codable, Equatable, Sendable {
    public var sessionId: String
    public var seq: Int
    public var entries: [VitalsEntry]
    public init(sessionId: String, seq: Int, entries: [VitalsEntry]) {
        self.sessionId = sessionId; self.seq = seq; self.entries = entries
    }
}

public struct SessionSummaryDims: Codable, Equatable, Sendable {
    public var platform: String
    public var appVersion: String
    public var sdkVersion: String
    public var deviceModel: String?
    public var osVersion: String?
    public init(platform: String, appVersion: String, sdkVersion: String, deviceModel: String? = nil, osVersion: String? = nil) {
        self.platform = platform; self.appVersion = appVersion; self.sdkVersion = sdkVersion
        self.deviceModel = deviceModel; self.osVersion = osVersion
    }
}

/// Every field is always present on the wire; the two nullable ones encode as
/// explicit `null` (zod `.nullable()` requires the key). Hence the hand-written
/// `encode(to:)` — synthesized Codable would omit them.
public struct SessionSummary: Codable, Equatable, Sendable {
    public var sessionId: String
    public var final: Bool
    public var seq: Int
    public var startedAt: Int64
    public var durationMs: Int64
    public var playtimeMs: Int64
    public var startupTimeMs: Int64?
    public var rebufferCount: Int
    public var rebufferDurationMs: Int64
    public var bitrateMean: Int64?
    public var errorCount: Int
    public var memPeak: Int64
    public var memAvg: Int64
    public var playerCount: Int
    public var playerCountSaturated: Bool
    public var dims: SessionSummaryDims

    public init(sessionId: String, final: Bool, seq: Int, startedAt: Int64, durationMs: Int64, playtimeMs: Int64,
                startupTimeMs: Int64?, rebufferCount: Int, rebufferDurationMs: Int64, bitrateMean: Int64?, errorCount: Int,
                memPeak: Int64, memAvg: Int64, playerCount: Int, playerCountSaturated: Bool, dims: SessionSummaryDims) {
        self.sessionId = sessionId; self.final = final; self.seq = seq; self.startedAt = startedAt
        self.durationMs = durationMs; self.playtimeMs = playtimeMs; self.startupTimeMs = startupTimeMs
        self.rebufferCount = rebufferCount; self.rebufferDurationMs = rebufferDurationMs; self.bitrateMean = bitrateMean
        self.errorCount = errorCount; self.memPeak = memPeak; self.memAvg = memAvg; self.playerCount = playerCount
        self.playerCountSaturated = playerCountSaturated; self.dims = dims
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(sessionId, forKey: .sessionId)
        try c.encode(final, forKey: .final)
        try c.encode(seq, forKey: .seq)
        try c.encode(startedAt, forKey: .startedAt)
        try c.encode(durationMs, forKey: .durationMs)
        try c.encode(playtimeMs, forKey: .playtimeMs)
        try c.encode(startupTimeMs, forKey: .startupTimeMs)      // nil → null (encode, not encodeIfPresent)
        try c.encode(rebufferCount, forKey: .rebufferCount)
        try c.encode(rebufferDurationMs, forKey: .rebufferDurationMs)
        try c.encode(bitrateMean, forKey: .bitrateMean)          // nil → null
        try c.encode(errorCount, forKey: .errorCount)
        try c.encode(memPeak, forKey: .memPeak)
        try c.encode(memAvg, forKey: .memAvg)
        try c.encode(playerCount, forKey: .playerCount)
        try c.encode(playerCountSaturated, forKey: .playerCountSaturated)
        try c.encode(dims, forKey: .dims)
    }
}

public enum VitalsIngestPayload: Codable, Equatable, Sendable {
    case chunk(VitalsChunk)
    case summary(SessionSummary)

    private enum KindKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: KindKey.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "chunk": self = .chunk(try VitalsChunk(from: decoder))
        case "summary": self = .summary(try SessionSummary(from: decoder))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown payload kind \(other)")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: KindKey.self)
        switch self {
        case let .chunk(x): try c.encode("chunk", forKey: .kind); try x.encode(to: encoder)
        case let .summary(x): try c.encode("summary", forKey: .kind); try x.encode(to: encoder)
        }
    }
}

// MARK: - Codec

/// Sorted keys so byte costs are deterministic; no escaped slashes so `src`
/// URLs measure the same bytes the server sees. Doubles that are integral
/// render as plain digits under Foundation's JSONEncoder, and `[String: Double]`
/// extras stay well inside the range where it would switch to exponent form.
public enum VitalsWireCodec {
    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return e
    }()
    private static let decoder = JSONDecoder()

    public static func encodePayload(_ p: VitalsIngestPayload) throws -> Data { try encoder.encode(p) }

    /// `{"payload": …}` — the route wrapper. `apiKey` is a web-only beacon
    /// affordance and is never sent from iOS.
    public static func encodeRequest(_ p: VitalsIngestPayload) throws -> Data {
        try encoder.encode(Request(payload: p))
    }

    /// One entry, encoded exactly as it appears inside a chunk's `entries`.
    /// The collector sums these per entry to estimate the framed cost cheaply
    /// (Android final review, I5).
    public static func encodeEntry(_ e: VitalsEntry) throws -> Data { try encoder.encode(e) }

    /// Decode is used by the parity tests only (the SDK never receives vitals). Note for
    /// `VitalsJSON.init(from:)`: on the macOS 14+ host Foundation's JSONDecoder tells `true`
    /// from `1`; older NSNumber-backed decoders did not, which is one more reason the SDK
    /// never decodes customer `data` on device.
    public static func decodePayload(_ data: Data) throws -> VitalsIngestPayload {
        try decoder.decode(VitalsIngestPayload.self, from: data)
    }

    public static func utf8Length(_ s: String) -> Int { s.utf8.count }

    private struct Request: Encodable { let payload: VitalsIngestPayload }
}
