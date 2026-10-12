// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit

enum NativeCrashRecoveryJournal {
    struct Stage: Codable {
        let schemaVersion: Int
        let rawHash: String
        let contextID: UUID
        let entry: OutboxEntry
    }
    struct Receipt: Codable {
        let schemaVersion: Int
        let rawHash: String
        let stageHash: String
        let reportID: UUID
    }
    enum Kind: String { case stage, receipt
        var maximum: Int { self == .stage ? 1024 * 1024 : 4096 }
    }
    private static let magic = Data("EFREC001".utf8)
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private static func aad(_ runID: UUID, _ kind: Kind) -> Data {
        magic + Data(("/" + kind.rawValue + "/" + runID.uuidString.lowercased()).utf8)
    }
    static func seal<T: Encodable>(_ value: T, runID: UUID, kind: Kind, key: Data) throws -> Data {
        guard key.count == 32 else { throw NativeCrashRecovery.Failure.unavailable }
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        let plain = try encoder.encode(value)
        guard plain.count <= kind.maximum - 36 else { throw NativeCrashRecovery.Failure.capacity }
        let box = try AES.GCM.seal(plain, using: SymmetricKey(data: key), authenticating: aad(runID, kind))
        guard let combined = box.combined else { throw NativeCrashRecovery.Failure.unavailable }
        return magic + combined
    }
    static func open<T: Decodable>(_ type: T.Type, bytes: Data, runID: UUID, kind: Kind, key: Data) throws -> T {
        guard key.count == 32 else { throw NativeCrashRecovery.Failure.unavailable }
        guard bytes.count <= kind.maximum, bytes.count >= 36, bytes.starts(with: magic) else { throw NativeCrashRecovery.Failure.journal }
        do {
            let sealed = try AES.GCM.SealedBox(combined: bytes.dropFirst(magic.count))
            let plain = try AES.GCM.open(sealed, using: SymmetricKey(data: key), authenticating: aad(runID, kind))
            let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(type, from: plain)
        } catch { throw NativeCrashRecovery.Failure.journal }
    }
}
