// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Wire types for device linking: the `evf_dev_` device token, attempt and
// link nonces, the owner a device is linked to, and the replies of the hello,
// attempt-check and ingest endpoints.
//
// Every decoder here returns nil for anything outside the contract and never
// throws out: a hostile or malformed reply means "no link / stop". An attempt
// id is a parsed `UUID`, so nothing unvalidated reaches a URL path.
//
// SECURITY: tokens and nonces are bearer secrets. Never log, print or put
// them in a URL.
import CryptoKit
import Foundation
import Security

/// The device token the server mints when a teammate approves a link.
enum DeviceLinkToken {
    static let prefix = "evf_dev_"
    static let bodyLength = 32

    /// `^evf_dev_[0-9A-Za-z]{32}$`.
    static func isValid(_ raw: String?) -> Bool {
        guard let raw, raw.hasPrefix(prefix) else { return false }
        let body = raw.utf8.dropFirst(prefix.utf8.count)
        return body.count == bodyLength && body.allSatisfy(DeviceLinkNonce.isAlphanumeric)
    }

    /// Lowercase hex of the first 8 bytes of SHA-256 of the token: 16
    /// characters. Lets a reply or a queued capture name the token it was sent
    /// with without holding the token itself.
    static func fingerprint(_ token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
    }
}

/// Attempt and link nonces: 32 characters of `[0-9A-Za-z]`.
enum DeviceLinkNonce {
    static let length = 32
    private static let alphabet = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz".utf8)

    static func make() -> String {
        var out: [UInt8] = []
        out.reserveCapacity(length)
        while out.count < length {
            var bytes = [UInt8](repeating: 0, count: 64)
            if SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) != errSecSuccess {
                // The system generator failing is not recoverable in a useful
                // way; fall back to the CSPRNG behind `SystemRandomNumberGenerator`.
                var rng = SystemRandomNumberGenerator()
                bytes = bytes.map { _ in UInt8.random(in: .min ... .max, using: &rng) }
            }
            // Rejection sampling: 248 = 4 * 62, so `byte % 62` stays uniform.
            for byte in bytes where byte < 248 && out.count < length {
                out.append(alphabet[Int(byte % 62)])
            }
        }
        return String(decoding: out, as: UTF8.self)
    }

    static func isAlphanumeric(_ byte: UInt8) -> Bool {
        (0x30...0x39).contains(byte) || (0x41...0x5A).contains(byte) || (0x61...0x7A).contains(byte)
    }
}

/// Who a device is linked to.
enum DeviceLinkOwner: Equatable, Sendable, Codable {
    case user(name: String)
    case team

    /// The toast once a capture is handed off on a linked device.
    var capturedToastText: String {
        switch self {
        case .user(let name): return "Captured · \(name)"
        case .team: return "Captured · team device"
        }
    }

    /// The toast once a link is approved.
    var linkedToastText: String {
        switch self {
        case .user(let name): return "Linked to \(name)"
        case .team: return "Linked as team device"
        }
    }

    private enum CodingKeys: String, CodingKey { case kind, name }

    /// `{"kind":"user","name":…}` with a non-empty trimmed name, or `{"kind":"team"}`.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "user":
            let name = try c.decode(String.self, forKey: .name).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty else {
                throw DecodingError.dataCorruptedError(forKey: .name, in: c, debugDescription: "empty owner name")
            }
            self = .user(name: name)
        case "team":
            self = .team
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: c, debugDescription: "unknown owner kind")
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .user(let name):
            try c.encode("user", forKey: .kind)
            try c.encode(name, forKey: .name)
        case .team:
            try c.encode("team", forKey: .kind)
        }
    }

    /// Lenient: nil for anything outside the contract.
    static func from(_ object: Any?) -> DeviceLinkOwner? {
        guard let object = object as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return try? JSONDecoder().decode(DeviceLinkOwner.self, from: data)
    }
}

/// Shared parsing helpers for the replies below.
enum DeviceLinkWireParse {
    static func object(_ data: Data) -> [String: Any]? {
        guard !data.isEmpty else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// A UUID string; anything else (a path, an empty string, a number) is nil.
    static func uuid(_ value: Any?) -> UUID? {
        guard let string = value as? String else { return nil }
        return UUID(uuidString: string)
    }

    /// An integer in 0...99. JSON booleans and fractional numbers are refused.
    static func matchingNumber(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.rounded() == double, (0...99).contains(double) else { return nil }
        return Int(double)
    }
}

/// `POST /api/device-link/hello` reply.
enum DeviceLinkHelloReply: Equatable, Sendable {
    case none
    case pending(attemptId: UUID, number: Int)

    static func decode(_ data: Data) -> DeviceLinkHelloReply? {
        guard let object = DeviceLinkWireParse.object(data) else { return nil }
        switch object["status"] as? String {
        case "none":
            return DeviceLinkHelloReply.none
        case "pending":
            guard let id = DeviceLinkWireParse.uuid(object["attemptId"]),
                  let number = DeviceLinkWireParse.matchingNumber(object["number"]) else { return nil }
            return .pending(attemptId: id, number: number)
        default:
            return nil
        }
    }
}

/// `POST /api/device-link/attempts/:attemptId/check` reply.
enum DeviceLinkCheckReply: Equatable, Sendable {
    case pending
    case linked(token: String, owner: DeviceLinkOwner)
    case expired

    static func decode(_ data: Data) -> DeviceLinkCheckReply? {
        guard let object = DeviceLinkWireParse.object(data) else { return nil }
        switch object["status"] as? String {
        case "pending":
            return .pending
        case "expired":
            return .expired
        case "linked":
            guard let token = object["token"] as? String, DeviceLinkToken.isValid(token),
                  let owner = DeviceLinkOwner.from(object["owner"]) else { return nil }
            return .linked(token: token, owner: owner)
        default:
            return nil
        }
    }
}

/// The `linkPending` member of a 200 ingest body: a teammate is taking this
/// linked device over.
struct DeviceLinkPending: Equatable, Sendable {
    let attemptId: UUID
    let number: Int

    static func fromIngestBody(_ data: Data) -> DeviceLinkPending? {
        guard let pending = DeviceLinkWireParse.object(data)?["linkPending"] as? [String: Any],
              let id = DeviceLinkWireParse.uuid(pending["attemptId"]),
              let number = DeviceLinkWireParse.matchingNumber(pending["number"]) else { return nil }
        return DeviceLinkPending(attemptId: id, number: number)
    }
}

/// Ingest refused a quick capture because its device token is revoked,
/// expired or unknown (`403 {"error":"device_unlinked"}`).
enum DeviceLinkRejection: Error, Equatable {
    case deviceUnlinked

    static func isDeviceUnlinkedBody(_ data: Data) -> Bool {
        DeviceLinkWireParse.object(data)?["error"] as? String == "device_unlinked"
    }
}

/// `POST /api/device-link/hello` request body.
struct DeviceLinkHelloRequest: Encodable, Sendable {
    let attemptNonce: String
    let device: Device

    struct Device: Encodable, Sendable, Equatable {
        let model: String
        let os: String
        let osVersion: String
        let appVersion: String
        let sdk: String
        /// `phone`, `tablet` or `tv`.
        let formFactor: String
    }
}
