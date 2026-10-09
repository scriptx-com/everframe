// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Host acceptance executable compiled with the actual SDK sources. Its fixed
/// encryption key and loopback transport are synthetic test inputs only.
@main enum NativeRecoveryProof {
    static let key = Data(repeating: 0x47, count: 32)
    static func printJSON<T: Encodable>(_ value: T) throws {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        FileHandle.standardOutput.write(try encoder.encode(value))
    }
    static func context(key: String, endpoint: String, user: String) throws -> NativeCrashRecoveryContext {
        let redaction = RedactionConfig(customPatterns: [try NSRegularExpression(pattern: "synthetic")])
        let template = try EnvelopeBuilder(redactor: RedactionEngine(), vitalsStamp: { nil }).buildEncoded(
            reportId: UUID(), sdkVersion: "1.0.0", extra: ["user.id": user, "app.version": "release-A", "device.os": "iOS"], source: .crash).bytes
        return try NativeCrashRecoveryContext(sdkKey: key, endpoint: endpoint, identitySubject: "subject-A",
            envelopeTemplate: template, redaction: NativeCrashRedactionSnapshot.capture(config: redaction))
    }
    static func main() async throws {
        let args = CommandLine.arguments
        guard args.count >= 3 else { exit(90) }
        let root = URL(fileURLWithPath: args[2]).standardizedFileURL
        let recovery = try NativeCrashRecovery(rootURL: root.appendingPathComponent("recovery"), activeRunIDs: [], keyProvider: { key })
        let outbox = JSONLOutbox(fileURL: root.appendingPathComponent("outbox"), keyProvider: { key })
        switch args[1] {
        case "prepare":
            guard args.count == 5, let endpoint = URLComponents(string: args[4]),
                  endpoint.scheme == "http", endpoint.host == "127.0.0.1" else { exit(90) }
            let run = try recovery.prepareRun()
            let contextID = try recovery.writeContext(context(key: args[3], endpoint: args[4], user: "user-A"), runID: run.id)
            try printJSON(["runID": run.id.uuidString.lowercased(), "contextID": contextID.uuidString.lowercased(), "recorderURL": run.recorderURL.path])
        case "recover":
            guard args.count == 5, let runID = UUID(uuidString: args[3]) else { exit(90) }
            // A new project/user exists while the old crash is recovered.
            let current = try recovery.prepareRun()
            _ = try recovery.writeContext(context(key: "new-project-B", endpoint: "https://example.invalid/api/ingest", user: "user-B"), runID: current.id)
            let result = try recovery.recover(runID: runID, outbox: outbox) { phase in
                if String(describing: phase) == args[4] { _exit(72) }
            }
            try printJSON(["outcome": String(describing: result), "queueCount": String(try outbox.hydrate().count)])
        case "export": try printJSON(outbox.hydrate())
        case "deliver":
            let submitter = ReportSubmitter(config: EverframeConfig(appId: "new-project-B"), outbox: outbox)
            await submitter.drainOutbox(identityHolder: IdentityTokenHolder(), currentReplayConfig: { .off },
                epochAtInitiation: 1, currentEpoch: { 1 })
            try printJSON(["queueCount": try outbox.hydrate().count])
        default: exit(90)
        }
    }
}
