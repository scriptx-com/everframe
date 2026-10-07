// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit

/// Compiled with the actual internal store sources for an isolated host proof.
/// The injected key and payloads are synthetic; no SDK configuration is read.
@main enum ContextProof {
    static let a = UUID(uuidString: "11111111-1111-4111-8111-111111111111")!
    static let b = UUID(uuidString: "22222222-2222-4222-8222-222222222222")!
    static func payload(_ id: UUID) -> Data {
        Data((id == a ? "synthetic-project-A:user-A:original-redaction-A" :
              "synthetic-project-B:user-B:later-redaction-B").utf8)
    }
    static func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    static func emit(_ value: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
        print(String(decoding: data, as: UTF8.self))
    }
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count >= 3 else { throw NSError(domain: "ContextProof.arguments", code: 1) }
        let root = URL(fileURLWithPath: args[2]).resolvingSymlinksInPath()
        let store = try NativeCrashContextStore(rootURL: root, keyProvider: { Data(repeating: 0x47, count: 32) })
        if args[1] == "prepare" {
            let run = try store.createRun()
            for id in [a, b] { _ = try store.writeContext(payload(id), runID: run.id, contextID: id) }
            try emit(["runID": run.id.uuidString.lowercased(), "payloadA": hash(payload(a)), "payloadB": hash(payload(b))])
            return
        }
        guard args[1] == "resolve", args.count == 5 else { throw NSError(domain: "ContextProof.arguments", code: 2) }
        let raw = try Data(contentsOf: URL(fileURLWithPath: args[3]))
        let report = try JSONSerialization.jsonObject(with: raw) as! [String: Any]
        let identifier = (report["user"] as? [String: Any])?["everframe_context_id"] as? String
        if args[4] == "none" {
            guard identifier == nil else { throw NSError(domain: "ContextProof.unexpectedOwner", code: 3) }
            try emit(["association": NSNull(), "rawSha256": hash(raw)])
            return
        }
        let expected = args[4] == "A" ? a : b
        guard identifier == expected.uuidString.lowercased(), let id = identifier.flatMap(UUID.init(uuidString:)) else {
            throw NSError(domain: "ContextProof.wrongOwner", code: 4)
        }
        let runs = try store.runs()
        guard runs.count == 1 else { throw NSError(domain: "ContextProof.runCount", code: 5) }
        let recovered = try store.readContext(runID: runs[0].id, contextID: id)
        guard recovered == payload(expected) else { throw NSError(domain: "ContextProof.changedBytes", code: 6) }
        let path = root.appendingPathComponent(runs[0].id.uuidString.lowercased()).appendingPathComponent(identifier! + ".evctx")
        let ciphertext = try Data(contentsOf: path)
        guard ciphertext.range(of: recovered) == nil else { throw NSError(domain: "ContextProof.plaintext", code: 7) }
        try emit(["association": identifier!, "runID": runs[0].id.uuidString.lowercased(),
                  "payloadSha256": hash(recovered), "ciphertextSha256": hash(ciphertext),
                  "rawSha256": hash(raw), "ciphertextPath": path.path])
    }
}
