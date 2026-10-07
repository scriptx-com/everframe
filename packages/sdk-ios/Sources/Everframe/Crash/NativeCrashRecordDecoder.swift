// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import CryptoKit
import EverframeProtocol

enum NativeCrashRecordDecoder {
    enum Failure: Error, Equatable {
        case inputLimit, collectionLimit, duplicateKey, malformed, unsupported, invalidIdentity, invalidTimestamp, crashedThread
    }

    /// The pinned 3.9.0 recorder captures the uncaught-exception handler stack with backtrace() into
    /// 97 slots (KSSC_CONTEXT_SIZE 100, less a two-word cursor header and one spare) and skips 3
    /// recorder frames, so a full buffer yields 94 frames with no truncation marker.
    private static let pinnedHandlerFrameCapacity = 94
    /// The image a normalized frame resolved to. dyld, and dyld_sim on simulators, are the OS images that start the
    /// main thread.
    private enum FrameImage { case app, system, dyld, dyldSim, unmatched }

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
        // NSException records keep the throw site in the exception's own backtrace. The crashed
        // thread holds the uncaught-exception handler, whose stack may already be unwound.
        let origin = fault.type == "nsexception" ? vendor.crash.last_exception_backtrace : nil
        let usesOrigin = origin.map { !$0.contents.values.isEmpty } ?? false
        let backtrace = usesOrigin ? origin : thread.backtrace
        let originLost = fault.type == "nsexception" && !usesOrigin
            && (origin != nil || vendor.crash.lastExceptionBacktraceMalformed)
        // A handler stack that filled the recorder's buffer may have lost its outer frames.
        let handlerCapped = fault.type == "nsexception" && !usesOrigin
            && (thread.backtrace?.contents.values.count ?? 0) >= pinnedHandlerFrameCapacity
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
        let type = text(rawType, limit: 256, redact: redact, fallback: fault.type, dropsCutToken: true)
        var images: [EverframeNativeCrashImage] = [], frames: [EverframeFrame] = [], crashInfo: [String] = []
        var nativeFrames: [EverframeNativeCrashFrame] = [], sourceToOutput: [Int: Int] = [:], appKeys: [String] = []
        var frameImages: [FrameImage] = []
        var imagesIncomplete = vendor.binary_images?.skipped ?? true
        var candidates: [(Int, NativeCrashVendorRecord.Image, String)] = []
        for (index, entry) in vendor.binary_images?.values ?? [] {
            guard let uuid = identifier(entry.uuid)?.uuidString.lowercased(),
                  validRange(entry.image_addr, entry.image_size),
                  entry.image_vmaddr.map({ validRange($0, entry.image_size) }) ?? true,
                  !basename(entry.name).isEmpty else { imagesIncomplete = true; continue }
            candidates.append((index, entry, uuid))
        }
        for entry in backtrace?.contents.values ?? [] {
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
                    // Runtime crash info only from images this stack references; others can be stale.
                    crashInfo += [image.crash_info_message, image.crash_info_message2].compactMap { $0 }
                }
                offset = hex(pc - image.image_addr)
                let kind = frameImage(image.name)
                if kind == .app { appKeys.append("\(uuid):\(hex(pc - image.image_addr))") }
                frameImages.append(kind)
            } else { imagesIncomplete = true; frameImages.append(.unmatched) }
            let symbol = entry.symbol_name.map { text($0, limit: 512, redact: redact, fallback: "<unknown>") }
            let raw = bounded("\(name) \(symbol ?? "<unknown>") \(hex(pc))", limit: 1024)
            frames.append(EverframeFrame(col: nil, file: nil, function: symbol, line: nil, raw: raw))
            nativeFrames.append(EverframeNativeCrashFrame(imageIndex: imageIndex, imageOffset: offset, instructionAddress: hex(pc)))
        }
        let message = text(fault.reason ?? (crashInfo.isEmpty ? rawType : crashInfo.joined(separator: "\n")),
                           limit: 4096, redact: redact, fallback: type, dropsCutToken: true)
        let error = EverframeNativeCrashError(faultAddress: fault.address.map(hex),
            machCode: fault.mach?.code.map { hex($0.value) }, machException: fault.mach.map { Int($0.exception) },
            machSubcode: fault.mach?.subcode.map { hex($0.value) },
            signalCode: fault.signal?.code.map(Int.init), signalNumber: fault.signal.map { Int($0.signal) })
        let native = EverframeNativeCrashMetadata(crashedThreadIndex: thread.index, error: error,
            frames: nativeFrames, framesIncomplete: backtrace == nil || originLost || handlerCapped
                || backtrace?.contents.incomplete == true || (backtrace?.skipped ?? 0) != 0,
            images: images, imagesIncomplete: imagesIncomplete, platform: .apple,
            timestampMicros: String(header.timestamp))
        // Key app frames: OS images hold terminate/abort machinery and change with every OS update.
        // When the entry point holds every app frame and the crashing frame is outside it, the fault is in
        // OS code and main alone would merge distinct faults, so the leading frames key the group, as they
        // do without any app frame.
        let entry = entryPoint(frameImages)
        let leading = appKeys.isEmpty || (entry > 0 && !frameImages[..<entry].contains(.app))
        let keys = leading ? nativeFrames.prefix(5).enumerated().map { index, frame in
            if let image = frame.imageIndex, let offset = frame.imageOffset { return "\(images[image].uuid):\(offset)" }
            return frames[index].function ?? "<unknown>"
        } : Array(appKeys.prefix(5))
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
    /// OS images: shared-cache, cryptex and simulator runtime paths, judged before basename stripping.
    private static func isSystemImage(_ path: String) -> Bool {
        ["/System/", "/usr/lib/", "/Library/Apple/", "/private/preboot/"].contains { path.hasPrefix($0) }
            || path.contains("/RuntimeRoot/")
    }
    private static func frameImage(_ path: String) -> FrameImage {
        guard isSystemImage(path) else { return .app }
        switch basename(path) { case "dyld": return .dyld; case "dyld_sim": return .dyldSim; default: return .system }
    }
    /// Where the entry point (main, or $main and main) begins: the app run directly above the loader's start, the
    /// stack's final OS frame. That is dyld's start on devices; on simulators the host's dyld start runs dyld_sim's
    /// start_sim, the loader's start there. Either loader image can be unlisted, so unmatched frames below a loader
    /// frame are skipped and an unmatched frame directly above dyld's start is start_sim. Without a final OS frame
    /// there is no entry point, and the frame count is returned.
    private static func entryPoint(_ images: [FrameImage]) -> Int {
        var start = images.count
        while start > 0, images[start - 1] == .unmatched { start -= 1 }
        if start > 0, images[start - 1] == .dyld || images[start - 1] == .dyldSim {
            start -= 1
            if images[start] == .dyld, start > 0, images[start - 1] == .dyldSim || images[start - 1] == .unmatched { start -= 1 }
        } else if images.last == .system { start = images.count - 1 } else { return images.count }
        while start > 0, images[start - 1] == .app { start -= 1 }
        return start
    }
    private static func basename(_ value: String) -> String {
        String(value.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last ?? "")
    }
    private static func imageName(_ value: String, redact: (String) -> String) -> String {
        let redacted = text(basename(value), limit: 256, redact: redact, fallback: "<unknown>")
        let safe = redacted.replacingOccurrences(of: "/", with: "").replacingOccurrences(of: "\\", with: "")
        return safe.isEmpty ? "<unknown>" : safe
    }
    private static func text(_ value: String, limit: Int, redact: (String) -> String, fallback: String,
                             dropsCutToken: Bool = false) -> String {
        // The redactor sees a 2x window with controls as spaces, so separators keep word boundaries
        // and secrets straddling the output cap stay whole. Runtime text also drops a token the window
        // cuts; symbol and image names come from binaries, and a cut mangled name would collapse.
        // The redactor's output is then stripped and capped.
        var window = bounded(value, limit: 2 * limit, separator: " ")
        if dropsCutToken, value.utf16.prefix(2 * limit + 1).count > 2 * limit {
            window = RedactionWindow.droppingCutToken(window)
        }
        let result = bounded(redact(window), limit: limit).trimmingCharacters(in: .whitespaces)
        return result.isEmpty ? fallback : result
    }
    private static func bounded(_ value: String, limit: Int, separator: Unicode.Scalar? = nil) -> String {
        var output = String.UnicodeScalarView(), units = 0
        for var scalar in value.unicodeScalars {
            if scalar.value < 32 || (127...159).contains(scalar.value) {
                guard let separator else { continue }
                scalar = separator
            }
            let count = scalar.value > 0xffff ? 2 : 1
            if units + count > limit { break }
            output.append(scalar); units += count
        }
        return String(output)
    }
}

/// Redaction matches secrets such as JWTs and card numbers only whole, so text cut by a scan window
/// drops the cut token and any digit group before it, exactly as the shared TypeScript normalizer
/// does. Cause chains share this rule; it lives here because the decoder's sources also build on their own.
enum RedactionWindow {
    static func droppingCutToken(_ text: String) -> String {
        let scalars = text.unicodeScalars
        var end = scalars.endIndex
        while end > scalars.startIndex, isTokenUnit(scalars[scalars.index(before: end)]) { end = scalars.index(before: end) }
        while end > scalars.startIndex, isDigitGroupUnit(scalars[scalars.index(before: end)]) { end = scalars.index(before: end) }
        return String(scalars[..<end])
    }
    /// Units of the tokens the shared redaction patterns match (JWT, bearer).
    private static func isTokenUnit(_ unit: Unicode.Scalar) -> Bool {
        switch unit.value {
        case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x2B, 0x2D, 0x2E, 0x2F, 0x3D, 0x5F, 0x7E: return true
        default: return false
        }
    }
    /// Digits, dashes and JavaScript whitespace: the units of card and SSN numbers.
    private static func isDigitGroupUnit(_ unit: Unicode.Scalar) -> Bool {
        switch unit.value {
        case 0x30...0x39, 0x2D, 0x09...0x0D, 0x20, 0xA0, 0x1680, 0x2000...0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
            return true
        default: return false
        }
    }
}
