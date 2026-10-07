// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import EverframeProtocol

enum NativeCrashRecordDecoder {
    enum Failure: Error, Equatable {
        case inputLimit, collectionLimit, duplicateKey, malformed, unsupported, invalidIdentity, invalidTimestamp, crashedThread
    }

    static func decode(_ data: Data, redact: (String) -> String) throws -> NativeCrashRecord {
        try NativeCrashJSONPreflight.validate(data)
        let vendor: NativeCrashVendorRecord
        do { vendor = try JSONDecoder().decode(NativeCrashVendorRecord.self, from: data) }
        catch let error as Failure { throw error }
        catch { throw Failure.malformed }
        let header = vendor.report, fault = vendor.crash.error
        guard header.version == "3.9.0", header.type == "standard", fault.is_fatal,
              fault.is_clean_exit != true, ["mach", "signal", "nsexception"].contains(fault.type)
        else { throw Failure.unsupported }
        guard let reportID = identifier(header.id) else { throw Failure.invalidIdentity }
        let runID = try optionalIdentifier(header.run_id)
        let context = vendor.user?.everframe_context_id
        if let context, context != context.lowercased() { throw Failure.invalidIdentity }
        let contextID = try optionalIdentifier(context)
        guard header.timestamp <= 253402300799999999 else { throw Failure.invalidTimestamp }
        let crashed = vendor.crash.threads.values.filter(\.crashed)
        guard crashed.count == 1, let thread = crashed.first, (0...65535).contains(thread.index)
        else { throw Failure.crashedThread }
        let rawType: String
        switch fault.type {
        case "mach":
            guard let mach = fault.mach else { throw Failure.malformed }
            rawType = mach.exception_name ?? "Mach exception \(mach.exception)"
        case "signal":
            guard let signal = fault.signal else { throw Failure.malformed }
            rawType = signal.name ?? "Signal \(signal.signal)"
        default: rawType = fault.nsexception?.name ?? "NSException"
        }
        let type = text(rawType, limit: 256, redact: redact, fallback: fault.type)
        let message = text(fault.reason ?? rawType, limit: 4096, redact: redact, fallback: type)
        var images: [EverframeNativeCrashImage] = [], frames: [EverframeFrame] = []
        var nativeFrames: [EverframeNativeCrashFrame] = [], sourceToOutput: [Int: Int] = [:]
        var imagesIncomplete = vendor.binary_images == nil
        var candidates: [(Int, NativeCrashVendorRecord.Image, String)] = []
        for (index, entry) in (vendor.binary_images?.values ?? []).enumerated() {
            guard let entry, let uuid = identifier(entry.uuid)?.uuidString.lowercased(),
                  validRange(entry.image_addr, entry.image_size),
                  entry.image_vmaddr.map({ validRange($0, entry.image_size) }) ?? true,
                  !basename(entry.name).isEmpty else { imagesIncomplete = true; continue }
            candidates.append((index, entry, uuid))
        }
        for entry in thread.backtrace?.contents.values ?? [] {
            let pc = entry.instruction_addr
            let matches = candidates.filter { _, image, uuid in
                !entry.associationMalformed && pc >= image.image_addr && pc - image.image_addr < image.image_size
                    && (entry.object_addr == nil || entry.object_addr == image.image_addr)
                    && (entry.object_uuid == nil || identifier(entry.object_uuid!)?.uuidString.lowercased() == uuid)
            }
            var imageIndex: Int?, offset: String?, name = "<unknown>"
            if matches.count == 1, let (sourceIndex, image, uuid) = matches.first {
                name = imageName(image.name, redact: redact)
                if let existing = sourceToOutput[sourceIndex] { imageIndex = existing }
                else {
                    imageIndex = images.count; sourceToOutput[sourceIndex] = images.count
                    images.append(EverframeNativeCrashImage(
                        architecture: architecture(image.cpu_type, image.cpu_subtype),
                        cpuSubtype: Int(image.cpu_subtype), cpuType: Int(image.cpu_type),
                        loadAddress: hex(image.image_addr), name: name, size: hex(image.image_size),
                        uuid: uuid, vmAddress: image.image_vmaddr.map(hex)))
                }
                offset = hex(pc - image.image_addr)
            } else { imagesIncomplete = true }
            let symbol = entry.symbol_name.map { text($0, limit: 512, redact: redact, fallback: "<unknown>") }
            let raw = bounded("\(name) \(symbol ?? "<unknown>") \(hex(pc))", limit: 1024)
            frames.append(EverframeFrame(col: nil, file: nil, function: symbol, line: nil, raw: raw))
            nativeFrames.append(EverframeNativeCrashFrame(imageIndex: imageIndex, imageOffset: offset, instructionAddress: hex(pc)))
        }
        let error = EverframeNativeCrashError(faultAddress: fault.address.map(hex),
            machCode: fault.mach?.code.map { hex($0.value) }, machException: fault.mach.map { Int($0.exception) },
            machSubcode: fault.mach?.subcode.map { hex($0.value) },
            signalCode: fault.signal?.code.map(Int.init), signalNumber: fault.signal.map { Int($0.signal) })
        let native = EverframeNativeCrashMetadata(crashedThreadIndex: thread.index, error: error,
            frames: nativeFrames, framesIncomplete: thread.backtrace == nil
                || thread.backtrace?.contents.incomplete == true || (thread.backtrace?.skipped ?? 0) != 0,
            images: images, imagesIncomplete: imagesIncomplete, platform: .apple,
            timestampMicros: String(header.timestamp))
        let keys = nativeFrames.prefix(5).enumerated().map { index, frame in
            if let image = frame.imageIndex, let offset = frame.imageOffset { return "\(images[image].uuid):\(offset)" }
            return frames[index].function ?? "<unknown>"
        }
        let fingerprint = SHA256.hash(data: Data(([type] + keys).joined(separator: "\n").utf8))
            .prefix(8).map { String(format: "%02x", $0) }.joined()
        let occurredAt = Date(timeIntervalSince1970: min(Double(header.timestamp) / 1_000_000, 253402300800.0.nextDown))
        return NativeCrashRecord(reportID: reportID, vendorRunID: runID, contextID: contextID,
            crash: EverframeCrash(causeChain: nil, details: nil, exceptionType: type, fatal: true,
                fingerprint: fingerprint, frames: frames, handled: false, jsBundle: nil, jvm: nil,
                mechanism: "native-\(fault.type)", message: message, native: native, occurredAt: occurredAt, threadName: nil))
    }

    private static func optionalIdentifier(_ value: String?) throws -> UUID? {
        guard let value else { return nil }
        guard let id = identifier(value) else { throw Failure.invalidIdentity }
        return id
    }
    private static func identifier(_ value: String) -> UUID? {
        guard value.utf8.count == 36, let id = UUID(uuidString: value),
              id.uuidString.lowercased() == value.lowercased() else { return nil }
        return id
    }
    private static func hex(_ value: UInt64) -> String { "0x" + String(value, radix: 16) }
    private static func validRange(_ start: UInt64, _ size: UInt64) -> Bool { size > 0 && size - 1 <= UInt64.max - start }
    private static func architecture(_ type: Int32, _ subtype: Int32) -> EverframeNativeCrashArchitecture {
        let subtype = UInt32(bitPattern: subtype) & 0x00ffffff
        if type == 0x0100000c { if subtype <= 1 { return .arm64 }; if subtype == 2 { return .arm64E } }
        if type == 0x01000007 { if subtype == 3 { return .x8664 }; if subtype == 8 { return .x8664H } }
        return .unknown
    }
    private static func basename(_ value: String) -> String {
        String(value.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? "")
    }
    private static func imageName(_ value: String, redact: (String) -> String) -> String {
        let redacted = text(basename(value), limit: 256, redact: redact, fallback: "<unknown>")
        let safe = redacted.replacingOccurrences(of: "/", with: "").replacingOccurrences(of: "\\", with: "")
        return safe.isEmpty ? "<unknown>" : safe
    }
    private static func text(_ value: String, limit: Int, redact: (String) -> String, fallback: String) -> String {
        let result = bounded(redact(bounded(value, limit: limit)), limit: limit)
        return result.isEmpty ? fallback : result
    }
    private static func bounded(_ value: String, limit: Int) -> String {
        var output = String.UnicodeScalarView(), units = 0
        for scalar in value.unicodeScalars {
            if scalar.value < 32 || (127...159).contains(scalar.value) { continue }
            let count = scalar.value > 0xffff ? 2 : 1
            if units + count > limit { break }
            output.append(scalar); units += count
        }
        return String(output)
    }
}
