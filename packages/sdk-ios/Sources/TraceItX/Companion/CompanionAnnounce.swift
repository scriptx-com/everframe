// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// POST /api/companion/announce — the device's one authenticated HTTP hop
// before the relay socket opens (spec 2026-08-07). A WebSocket handshake has
// nowhere safe to carry the SDK key (a key in the socket URL is written into
// every access log), so the key is proven here over ordinary HTTPS and spent
// as a single-use ticket on `/relay/tv/<ticket>`.
//
// EVERY failure returns nil. A device that cannot announce — offline, revoked
// key, older server with no such route (404), timeout, malformed body, TLS
// failure — falls back to plain `/relay/tv` and behaves exactly as it did
// before this feature existed: the QR works, pairing works, reports land. It
// is simply absent from the dashboard's device list. Companion auth failing
// must never cost a team their bug reporting; that rule outranks everything
// else in this file.
//
// SECURITY: never log the ticket. It is a bearer credential for exactly one
// relay handshake; it belongs in the socket URL and nowhere else.
//
// Port of `packages/sdk-react/src/companion/announce.ts` — same contract,
// same all-failures-are-nil disposition.
import Foundation

/// Injectable HTTP transport. Production uses `URLSession.shared.data(for:)`;
/// tests substitute a closure so no unit test ever touches the network.
typealias AnnounceTransport = @Sendable (URLRequest) async throws -> (Data, URLResponse)

/// A successful announce: the single-use relay ticket plus the short display
/// code the host renders beside the QR so a dashboard user can pick this
/// device out of the project's list.
struct AnnounceResult: Sendable, Equatable {
    let ticket: String
    let code: String
    /// Server-resolved display name (naming spec 2026-08-24) — a custom
    /// rename, falling back to a host label, falling back to a
    /// server-composed default from the `device` block. `nil` when the
    /// response omitted the field (older server), it was JSON `null`, or it
    /// was present but blank.
    let resolvedName: String?
}

struct CompanionAnnounce: Sendable {

    /// Wire shape of a 200 body. Decoding through a struct (rather than a
    /// dictionary of `Any`) is what makes a non-string `ticket` or a missing
    /// `code` fail closed — both throw here and become nil.
    private struct Wire: Decodable {
        let ticket: String
        let code: String
        let resolvedName: String?
    }

    private let endpoint: URL
    /// SECURITY: do not log.
    private let sdkKey: String
    private let timeout: TimeInterval
    private let transport: AnnounceTransport

    init(
        endpoint: URL,
        sdkKey: String,
        timeout: TimeInterval = 5,
        transport: @escaping AnnounceTransport = { try await URLSession.shared.data(for: $0) }
    ) {
        self.endpoint = endpoint
        self.sdkKey = sdkKey
        self.timeout = timeout
        self.transport = transport
    }

    /// Announce this device and return its ticket + display code, or nil on
    /// ANY failure. Callers must treat nil as "connect ticketless" — never as
    /// an error worth surfacing or retrying here (the next reconnect attempt
    /// re-announces; the fallback IS the retry).
    ///
    /// - Parameter supportsAttachPin: Advertises that this device will render
    ///   an attach-PIN when the relay pushes `attach.challenge` (spec
    ///   2026-08-19). Defaults to `false`, which omits the field entirely
    ///   (see `body(label:supportsAttachPin:device:)`) — an old server that
    ///   doesn't know the key sees a byte-identical body to before this
    ///   feature.
    /// - Parameter device: Stable device identity + facts (naming spec
    ///   2026-08-24). Defaults to `nil`, which omits the `device` key
    ///   entirely — an old server ignores the absent key, and a client that
    ///   failed to resolve one (Keychain unavailable, no explicit override)
    ///   sends a byte-identical body to before this feature.
    func announce(label: String?, supportsAttachPin: Bool = false, device: AnnounceDevice? = nil) async -> AnnounceResult? {
        guard let url = Self.announceURL(endpoint: endpoint) else { return nil }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        // A hung announce would stall companion start indefinitely and leave
        // the host with no QR at all — bound it and fall back instead.
        req.timeoutInterval = timeout
        req.setValue("Bearer \(sdkKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Self.body(label: label, supportsAttachPin: supportsAttachPin, device: device)

        do {
            let (data, response) = try await transport(req)
            guard let http = response as? HTTPURLResponse,
                  (200...299).contains(http.statusCode)
            else { return nil }
            guard let wire = try? JSONDecoder().decode(Wire.self, from: data) else { return nil }
            // Present-but-blank is not a usable answer. `{"ticket":"","code":""}`
            // decodes perfectly, and a blank ticket composes the socket URL
            // `/relay/tv/` — which the relay rejects as a 4004 TERMINAL close,
            // i.e. the device stops reporting entirely, instead of taking the
            // clean ticketless fallback this contract promises. Fail closed.
            // Mirrors `CompanionAnnounce.kt`'s `isBlank()` guard and
            // `sdk-react/src/companion/announce.ts`'s `.trim()` guard.
            guard !wire.ticket.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !wire.code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { return nil }
            // Same blank-guard as ticket/code, but not-fatal: an unusable
            // `resolvedName` just falls back to the host's own default-name
            // rendering, it never invalidates the whole announce.
            let resolvedName: String? = {
                guard let raw = wire.resolvedName,
                      !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                else { return nil }
                return raw
            }()
            return AnnounceResult(ticket: wire.ticket, code: wire.code, resolvedName: resolvedName)
        } catch {
            // Offline, timeout, TLS failure, cancellation — one answer.
            // SECURITY: the error is deliberately not logged; URLError
            // descriptions echo the request URL.
            return nil
        }
    }

    /// `<endpoint>/api/companion/announce`, preserving any base path the host
    /// configured (mirrors `MultipartUploader`'s `/api/ingest` suffixing).
    static func announceURL(endpoint: URL) -> URL? {
        var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        let basePath = (components?.path ?? "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let suffix = "api/companion/announce"
        components?.path = "/" + (basePath.isEmpty ? suffix : "\(basePath)/\(suffix)")
        return components?.url
    }

    /// `{"label":"…","supportsAttachPin":true,"device":{…}}` with each field
    /// omitted when absent/false/nil — a false `supportsAttachPin` and a nil
    /// `device` both keep the body byte-identical to old SDKs, which is what
    /// lets an old server (that doesn't know either key) ignore them
    /// harmlessly rather than rejecting an unrecognized field.
    static func body(label: String?, supportsAttachPin: Bool = false, device: AnnounceDevice? = nil) -> Data {
        struct BodyWire: Encodable {
            struct Device: Encodable {
                let id: String
                let platform: String
                let model: String?
                let osName: String?
                let osVersion: String?
                let emulator: Bool
            }
            let label: String?
            let supportsAttachPin: Bool?
            let device: Device?
        }
        let deviceWire = device.map {
            BodyWire.Device(
                id: $0.id, platform: $0.platform, model: $0.model,
                osName: $0.osName, osVersion: $0.osVersion, emulator: $0.emulator)
        }
        let wire = BodyWire(
            label: label,
            supportsAttachPin: supportsAttachPin ? true : nil,
            device: deviceWire)
        let encoder = JSONEncoder()
        // `.sortedKeys`: without it, `JSONEncoder` on Apple platforms does
        // NOT preserve declaration/encode-call order — it's the underlying
        // `NSDictionary`'s hash-bucket order, which is unspecified and
        // varies by key SET (confirmed empirically: the un-sorted `Device`
        // block came out `id, emulator, osVersion, osName, model, platform`,
        // matching neither declaration order nor any other obvious rule).
        // Every body this file has ever sent before `device` existed had at
        // most one key, so that nondeterminism was invisible — a multi-key
        // body (this one, once `device` is present) needs an explicit,
        // testable order, and `.sortedKeys` is the cheapest one available.
        encoder.outputFormatting = [.sortedKeys]
        // Encodable omits nil optionals by default via encodeIfPresent-style
        // synthesis, so `{}` is the fallback only for the (practically
        // impossible) case JSONEncoder itself throws.
        return (try? encoder.encode(wire)) ?? Data("{}".utf8)
    }
}
