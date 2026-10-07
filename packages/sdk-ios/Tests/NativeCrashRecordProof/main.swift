// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeProtocol

/// Host acceptance harness, compiled with the real decoder. No live SDK state.
@main enum NativeRecordProof {
    struct Output: Encodable {
        let reportID: String
        let vendorRunID: String?
        let contextID: String?
        let crash: EverframeCrash
    }
    static func main() throws {
        let args = CommandLine.arguments
        guard args.count == 2 else { throw NativeCrashRecordDecoder.Failure.malformed }
        let value = try NativeCrashRecordDecoder.decode(Data(contentsOf: URL(fileURLWithPath: args[1])), redact: { $0 })
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]; encoder.dateEncodingStrategy = .iso8601
        let output = Output(reportID: value.reportID.uuidString.lowercased(),
            vendorRunID: value.vendorRunID?.uuidString.lowercased(), contextID: value.contextID?.uuidString.lowercased(),
            crash: value.crash)
        FileHandle.standardOutput.write(try encoder.encode(output))
    }
}
