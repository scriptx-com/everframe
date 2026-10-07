// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import XCTest
import Foundation
import EverframeProtocol
@testable import EverframeKit

final class NativeCrashRecordDecoderTests: XCTestCase {
    let reportID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    let contextID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    let imageID = "cccccccc-cccc-cccc-cccc-cccccccccccc"
    let systemID = "dddddddd-dddd-dddd-dddd-dddddddddddd"
    func image(base: UInt64 = 0x20000000000001, size: UInt64 = 0x100, uuid: String? = nil,
               name: String = "/Applications/App.app/App") -> [String: Any] {
        ["image_addr": base, "image_vmaddr": UInt64(0x100000000), "image_size": size,
         "uuid": (uuid ?? imageID).uppercased(), "name": name,
         "cpu_type": 16777228, "cpu_subtype": 0]
    }
    func frame(pc: UInt64 = 0x20000000000011, symbol: String = "fatalFunction") -> [String: Any] {
        ["instruction_addr": pc, "symbol_name": symbol]
    }
    func record(type: String = "mach", frames: [[String: Any]]? = nil,
                images: [[String: Any]]? = nil, exceptionFrames: [[String: Any]]? = nil) -> [String: Any] {
        let value: [String: Any] = ["report": ["version": "3.9.0", "type": "standard", "id": reportID.uppercased(),
                    "run_id": reportID, "timestamp": UInt64(1791331200000001)],
         "user": ["everframe_context_id": contextID],
         "binary_images": images ?? [image()],
         "crash": ["error": ["type": type, "is_fatal": true, "is_clean_exit": false,
                            "address": UInt64(0x20000000000011),
                            "mach": ["exception": 6, "exception_name": "EXC_BREAKPOINT", "code": 1, "subcode": 0],
                            "signal": ["signal": 5, "name": "SIGTRAP", "code": 0],
                            "nsexception": ["name": "CustomException", "userInfo": ["secret": "NEVER_COPY"]],
                            "reason": "failure"],
                   "threads": [["index": 7, "crashed": true, "backtrace": ["contents": frames ?? [frame()]]]]]]
        guard let exceptionFrames else { return value }
        return changeCrash(value, "last_exception_backtrace", ["contents": exceptionFrames, "skipped": 0])
    }
    func data(_ value: [String: Any]) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
    func decode(_ value: [String: Any], redact: (String) -> String = { $0 }) throws -> NativeCrashRecord {
        try NativeCrashRecordDecoder.decode(data(value), redact: redact)
    }
    func changeError(_ input: [String: Any], _ key: String, _ value: Any) -> [String: Any] {
        var input = input, crash = input["crash"] as! [String: Any], error = crash["error"] as! [String: Any]
        error[key] = value; crash["error"] = error; input["crash"] = crash; return input
    }
    func changeCrash(_ input: [String: Any], _ key: String, _ value: Any) -> [String: Any] {
        var input = input, crash = input["crash"] as! [String: Any]
        crash[key] = value; input["crash"] = crash; return input
    }
    func testThreeFaultClassesPreserveOriginalIdentityAndExactAddresses() throws {
        for (type, expected) in [("mach", "EXC_BREAKPOINT"), ("signal", "SIGTRAP"), ("nsexception", "CustomException")] {
            let value = try decode(record(type: type)), native = try XCTUnwrap(value.crash.native)
            XCTAssertEqual(value.reportID.uuidString.lowercased(), reportID)
            XCTAssertEqual(value.vendorRunID?.uuidString.lowercased(), reportID)
            XCTAssertEqual(value.contextID?.uuidString.lowercased(), contextID)
            XCTAssertEqual(value.crash.exceptionType, expected)
            XCTAssertEqual(value.crash.mechanism, "native-\(type)")
            XCTAssertFalse(value.crash.handled); XCTAssertEqual(value.crash.fatal, true)
            XCTAssertEqual(native.timestampMicros, "1791331200000001")
            XCTAssertEqual(native.crashedThreadIndex, 7)
            XCTAssertEqual(native.frames[0].instructionAddress, "0x20000000000011")
            XCTAssertEqual(native.frames[0].imageOffset, "0x10")
            XCTAssertEqual(native.images[0].loadAddress, "0x20000000000001")
            XCTAssertEqual(native.images[0].uuid, imageID); XCTAssertEqual(native.images[0].name, "App")
            XCTAssertNil(value.crash.frames[0].file); XCTAssertNil(value.crash.frames[0].line)
        }
    }
    func testMaxAddressAndASLRStableFingerprint() throws {
        var last = image(base: UInt64.max, size: 1); last.removeValue(forKey: "image_vmaddr")
        let edge = try decode(record(frames: [frame(pc: UInt64.max)], images: [last]))
        XCTAssertEqual(edge.crash.native?.frames[0].instructionAddress, "0xffffffffffffffff")
        XCTAssertEqual(edge.crash.native?.frames[0].imageOffset, "0x0")
        let moved = try decode(record(frames: [frame(pc: 0x9010)], images: [image(base: 0x9000)]))
        XCTAssertEqual(try decode(record()).crash.fingerprint, moved.crash.fingerprint)
    }
    func testMissingContextRemainsMissingAndInvalidIdentifiersReject() throws {
        var value = record(); value.removeValue(forKey: "user")
        XCTAssertNil(try decode(value).contextID)
        value["user"] = ["everframe_context_id": contextID.uppercased()]
        XCTAssertThrowsError(try decode(value))
        value = record(); var header = value["report"] as! [String: Any]; header["id"] = "sensitive-invalid-id"
        value["report"] = header
        XCTAssertThrowsError(try decode(value)) { XCTAssertTrue($0 is NativeCrashRecordDecoder.Failure) }
    }
    func testUnsupportedNonfatalAndInvalidTimestampsReject() throws {
        for (key, value) in [("version", "4.0"), ("type", "minimal"), ("timestamp", -1), ("timestamp", UInt64.max)] as [(String, Any)] {
            var input = record(), header = input["report"] as! [String: Any]; header[key] = value; input["report"] = header
            XCTAssertThrowsError(try decode(input))
        }
        for input in [record(type: "cpp_exception"), changeError(record(), "is_fatal", false),
                      changeError(record(), "is_clean_exit", true)] { XCTAssertThrowsError(try decode(input)) }
    }
    func testCrashedThreadMustBeUniqueAndBounded() throws {
        // Over the recorder's 1000-thread maximum, the record is otherwise valid: exactly one thread crashed.
        let overLimit = Array(repeating: ["index": 0, "crashed": false], count: 1000) + [["index": 1000, "crashed": true]]
        for (threads, expected): ([[String: Any]], NativeCrashRecordDecoder.Failure) in [
            ([], .crashedThread), ([["index": 0, "crashed": false]], .crashedThread),
            ([["index": 0, "crashed": true], ["index": 1, "crashed": true]], .crashedThread),
            (overLimit, .collectionLimit), ([["index": 65536, "crashed": true]], .crashedThread)] {
            var input = record(), crash = input["crash"] as! [String: Any]; crash["threads"] = threads; input["crash"] = crash
            XCTAssertThrowsError(try decode(input)) { XCTAssertEqual($0 as? NativeCrashRecordDecoder.Failure, expected) }
        }
    }
    func testMalformedCappedAndAbsentStacksStayAlignedAndHonest() throws {
        let result = try decode(record(frames: [frame(), ["instruction_addr": "bad"], frame(pc: 0x20000000000012)]))
        XCTAssertEqual(result.crash.frames.count, 2); XCTAssertEqual(result.crash.native?.frames.count, 2)
        XCTAssertEqual(result.crash.native?.framesIncomplete, true)
        XCTAssertEqual(result.crash.native?.frames[1].instructionAddress, "0x20000000000012")
        let capped = try decode(record(frames: Array(repeating: frame(), count: 257)))
        XCTAssertEqual(capped.crash.frames.count, 256); XCTAssertEqual(capped.crash.native?.framesIncomplete, true)
        var input = record(), crash = input["crash"] as! [String: Any]
        crash["threads"] = [["index": 0, "crashed": true]]; input["crash"] = crash
        XCTAssertTrue(try decode(input).crash.frames.isEmpty)
        XCTAssertEqual(try decode(input).crash.native?.framesIncomplete, true)
    }
    func testAmbiguousMismatchedAndOverflowingImagesNeverInventMapping() throws {
        var mismatch = frame(); mismatch["object_addr"] = UInt64(3)
        var badUUID = frame(); badUUID["object_uuid"] = reportID
        var malformedUUID = frame(); malformedUUID["object_uuid"] = 123
        var overflow = image(base: UInt64.max, size: 2)
        var vmOverflow = image(); vmOverflow["image_vmaddr"] = UInt64.max
        for input in [record(images: []), record(images: [image(), image()]), record(frames: [mismatch]),
                      record(frames: [badUUID]), record(frames: [malformedUUID]), record(images: [overflow]),
                      record(images: [vmOverflow]), record(images: [["name": "only-name"]])] {
            let native = try XCTUnwrap(decode(input).crash.native)
            XCTAssertNil(native.frames[0].imageIndex); XCTAssertNil(native.frames[0].imageOffset)
            XCTAssertTrue(native.imagesIncomplete); XCTAssertEqual(native.frames[0].instructionAddress, "0x20000000000011")
        }
        overflow = image(); overflow["cpu_subtype"] = 2
        XCTAssertEqual(try decode(record(images: [overflow])).crash.native?.images[0].architecture, .arm64E)
    }
    func testSensitiveUnknownFieldsIgnoredAndExpandingRedactionRebounded() throws {
        let long = String(repeating: "x", count: 20_000)
        var input = record(type: "nsexception", frames: [frame(symbol: "SYMBOL" + long)],
                           images: [image(name: "/Applications/App.app/IMAGE" + long)])
        input["system"] = ["path": "NEVER_COPY"]; input["memory"] = ["token": "NEVER_COPY"]
        input = changeError(changeError(input, "reason", "REASON" + long), "nsexception", ["name": "NAME" + long])
        var inputs: [String] = []
        let result = try decode(input, redact: { inputs.append($0); return "/redacted\\\u{0}" + String(repeating: "😀", count: 5000) })
        // Each field reaches the redactor already bounded, and is bounded again afterwards.
        for (prefix, limit) in [("REASON", 8192), ("NAME", 512), ("SYMBOL", 1024), ("IMAGE", 512)] {
            let seen = inputs.filter { $0.hasPrefix(prefix) }
            XCTAssertFalse(seen.isEmpty, prefix)
            XCTAssertTrue(seen.allSatisfy { $0.utf16.count <= limit }, prefix)
        }
        let native = try XCTUnwrap(result.crash.native)
        XCTAssertLessThanOrEqual(result.crash.message.utf16.count, 4096)
        XCTAssertLessThanOrEqual(result.crash.exceptionType.utf16.count, 256)
        XCTAssertLessThanOrEqual(native.images[0].name.utf16.count, 256)
        XCTAssertTrue(result.crash.frames.allSatisfy { ($0.function?.utf16.count ?? 0) <= 512 && $0.raw.utf16.count <= 1024 })
        XCTAssertEqual(result.crash.frames[0].function?.utf16.count, 512)
        XCTAssertFalse(native.images[0].name.contains("/")); XCTAssertFalse(native.images[0].name.contains("\\"))
        XCTAssertFalse(native.images[0].name.contains("\u{0}"))
        let encoded = String(decoding: try JSONEncoder().encode(result.crash), as: UTF8.self)
        XCTAssertFalse(encoded.contains("NEVER_COPY")); XCTAssertFalse(encoded.contains("Applications"))
    }
    func testNonIntegerStructuralTokensRejectBeforeFoundationCanRoundThem() throws {
        var associated = frame(); associated["object_addr"] = UInt64(0x20000000000001)
        let original = String(decoding: try data(record(frames: [associated])), as: UTF8.self)
        let cases = [
            ("instruction_addr", "9007199254740993.1"), ("image_addr", "9007199254740993.1"),
            ("image_size", "256.0000000000000001"), ("image_vmaddr", "4294967296.0000000001"),
            ("object_addr", "9007199254740993.1"), ("timestamp", "1791331200000001.1"),
            ("cpu_type", "16777228.0000000001"), ("cpu_subtype", "0.00000000000000000001"),
            ("index", "7.0000000000000001"), ("exception", "6.0000000000000001"),
            ("code", "-9223372036854775808.1"), ("subcode", "9007199254740993.1"),
            ("address", "9007199254740993.1"), ("signal", "5.0000000000000001"),
            // Even mathematically integral alternate spellings fail closed for structural fields.
            ("instruction_addr", "9007199254740993.0"), ("instruction_addr", "9.007199254740993e15")
        ]
        for (key, token) in cases {
            let pattern = #"""# + key + #"":-?[0-9]+"#
            let range = try XCTUnwrap(original.range(of: pattern, options: .regularExpression))
            let altered = original.replacingCharacters(in: range, with: #"""# + key + #"":"# + token)
            XCTAssertThrowsError(try NativeCrashRecordDecoder.decode(Data(altered.utf8), redact: { $0 }), key + ":" + token) {
                XCTAssertEqual($0 as? NativeCrashRecordDecoder.Failure, .malformed, key + ":" + token)
            }
        }
        // The NSException origin backtrace (sorted before threads) carries the same structural integers.
        let origin = String(decoding: try data(record(type: "nsexception", exceptionFrames: [associated])), as: UTF8.self)
        for (key, token) in [("instruction_addr", "9007199254740993.1"), ("object_addr", "9007199254740993.1"), ("skipped", "0.1")] {
            let range = try XCTUnwrap(origin.range(of: #"""# + key + #"":-?[0-9]+"#, options: .regularExpression))
            let altered = origin.replacingCharacters(in: range, with: #"""# + key + #"":"# + token)
            XCTAssertThrowsError(try NativeCrashRecordDecoder.decode(Data(altered.utf8), redact: { $0 }), "origin " + key) {
                XCTAssertEqual($0 as? NativeCrashRecordDecoder.Failure, .malformed, "origin " + key)
            }
        }
        // Unknown metadata must not inherit the structural integer-only spelling rule.
        let ignored = #"{"system":{"timestamp":1791331200000001.1,"code":1.5,"uptime":1e-3},"# + original.dropFirst()
        XCTAssertNoThrow(try NativeCrashRecordDecoder.decode(Data(ignored.utf8), redact: { $0 }))
    }
    func testByteDepthKeyAndEscapedDuplicateBoundsBeforeDecode() throws {
        let original = String(decoding: try data(record()), as: UTF8.self)
        let suffix = String(original.dropFirst())
        // Each input would decode if only its own bound were missing.
        var padded = record(); padded["padding"] = String(repeating: "x", count: 2 * 1024 * 1024)
        let invalid: [(Data, NativeCrashRecordDecoder.Failure)] = [
            (try data(padded), .inputLimit),
            (Data(("{\"unknown\":" + String(repeating: "[", count: 65) + "0" + String(repeating: "]", count: 65) + "," + suffix).utf8), .inputLimit),
            (Data(("{\"duplicate\":1,\"dupli\\u0063ate\":2," + suffix).utf8), .duplicateKey),
            (Data(("{\"" + String(repeating: "x", count: 1025) + "\":0," + suffix).utf8), .inputLimit),
            (Data(#"{"secret":"#.utf8), .malformed),
        ]
        for (bytes, expected) in invalid {
            XCTAssertThrowsError(try NativeCrashRecordDecoder.decode(bytes, redact: { $0 })) {
                XCTAssertEqual($0 as? NativeCrashRecordDecoder.Failure, expected)
                XCTAssertFalse(String(describing: $0).contains("secret"))
            }
        }
        // Identical keys in separate objects are legal.
        XCTAssertNoThrow(try decode(record()))
    }
    func testNSExceptionUsesExceptionOriginBacktrace() throws {
        let images = [image(base: 0x180000000, size: 0x100000, uuid: systemID,
                            name: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"), image()]
        // The uncaught handler can run after the throw site was unwound (for example inside GCD).
        let handler = [frame(pc: 0x180000010, symbol: "__handleUncaughtException"),
                       frame(pc: 0x180000020, symbol: "_objc_terminate"), frame(pc: 0x180000030, symbol: "_dispatch_client_callout")]
        let origin = [frame(pc: 0x180000040, symbol: "__exceptionPreprocess"),
                      frame(pc: 0x180000050, symbol: "objc_exception_throw"), frame(pc: 0x20000000000021, symbol: "appClosure")]
        let result = try decode(record(type: "nsexception", frames: handler, images: images, exceptionFrames: origin))
        let native = try XCTUnwrap(result.crash.native)
        XCTAssertEqual(result.crash.frames.map(\.function), ["__exceptionPreprocess", "objc_exception_throw", "appClosure"])
        XCTAssertEqual(native.frames.map(\.instructionAddress), ["0x180000040", "0x180000050", "0x20000000000021"])
        XCTAssertEqual(native.frames[2].imageIndex.map { native.images[$0].name }, "App")
        XCTAssertEqual(native.crashedThreadIndex, 7); XCTAssertFalse(native.framesIncomplete)
        // Without an origin, and for other fault types, the crashed thread stays the source.
        for input in [record(type: "nsexception", frames: handler, images: images),
                      record(type: "mach", frames: handler, images: images, exceptionFrames: origin)] {
            XCTAssertEqual(try decode(input).crash.frames.map(\.function),
                           ["__handleUncaughtException", "_objc_terminate", "_dispatch_client_callout"])
        }
        // A malformed origin falls back to the handler stack and is reported incomplete.
        let malformed = changeCrash(record(type: "nsexception", frames: handler, images: images),
                                    "last_exception_backtrace", ["contents": "bad"])
        let fallback = try XCTUnwrap(decode(malformed).crash.native)
        XCTAssertEqual(fallback.frames.map(\.instructionAddress), ["0x180000010", "0x180000020", "0x180000030"])
        XCTAssertTrue(fallback.framesIncomplete)
    }
    func testFingerprintKeysAppFramesNotSystemMachinery() throws {
        let system: [(String, UInt64)] = [
            ("/usr/lib/system/libsystem_kernel.dylib", 0x180000000), ("/usr/lib/libc++abi.dylib", 0x181000000),
            ("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", 0x182000000),
            ("/Library/Developer/CoreSimulator/Volumes/iOS/Library/Developer/CoreSimulator/Profiles/Runtimes/"
             + "iOS.simruntime/Contents/Resources/RuntimeRoot/usr/lib/libobjc.A.dylib", 0x183000000)]
        func images(build: Int) -> [[String: Any]] {
            system.enumerated().map { index, entry in
                image(base: entry.1, size: 0x100000, uuid: String(format: "%08lx-0000-4000-8000-%012lx", build, index), name: entry.0)
            } + [image()]
        }
        let machinery = [frame(pc: 0x180000010), frame(pc: 0x181000010), frame(pc: 0x181000020),
                         frame(pc: 0x182000010), frame(pc: 0x183000010)]
        func fingerprint(_ type: String, site: UInt64, build: Int = 1) throws -> String {
            try decode(record(type: type, frames: machinery + [frame(pc: site)], images: images(build: build))).crash.fingerprint
        }
        for type in ["nsexception", "mach"] {
            // Identical terminate/abort machinery must not merge distinct app call sites.
            XCTAssertNotEqual(try fingerprint(type, site: 0x20000000000011), try fingerprint(type, site: 0x20000000000021), type)
            // An OS update changes system image identity, not the app call site's group.
            XCTAssertEqual(try fingerprint(type, site: 0x20000000000011), try fingerprint(type, site: 0x20000000000011, build: 2), type)
        }
        // Without any app frame, the leading frames still key the group.
        XCTAssertNotEqual(try decode(record(frames: machinery, images: images(build: 1))).crash.fingerprint,
                          try decode(record(frames: Array(machinery.reversed()), images: images(build: 1))).crash.fingerprint)
    }
    func testDefaultRedactionSeesSeparatorsAndSecretsStraddlingTheCap() throws {
        let jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJqYW5lQGV4YW1wbGUuY29tIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c"
        for (reason, secret) in [("Payment declined\n4111111111111111\nCode 51", "4111111111111111"),
                                 ("Applicant ID\t123-45-6789", "123-45-6789"), ("Bearer\tabc.def-123", "abc.def-123"),
                                 (String(repeating: "a ", count: 2030) + jwt, "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")] {
            let input = changeError(record(type: "nsexception"), "reason", reason)
            let message = try decode(input, redact: { RedactionEngine().redact($0) }).crash.message
            XCTAssertFalse(message.contains(secret), secret)
            XCTAssertLessThanOrEqual(message.utf16.count, 4096)
            XCTAssertFalse(message.unicodeScalars.contains { $0.value < 32 || (127...159).contains($0.value) }, secret)
        }
    }
    func testNSExceptionHandlerStackAtRecorderCapacityIsIncomplete() throws {
        // The pinned recorder writes at most 94 uncaught-handler frames, with no truncation marker.
        for (type, count, expected) in [("nsexception", 94, true), ("nsexception", 93, false), ("mach", 94, false)] {
            let native = try XCTUnwrap(decode(record(type: type, frames: Array(repeating: frame(), count: count))).crash.native)
            XCTAssertEqual(native.framesIncomplete, expected, "\(type) \(count)")
        }
        let origin = try decode(record(type: "nsexception", frames: Array(repeating: frame(), count: 94),
                                       exceptionFrames: Array(repeating: frame(), count: 94)))
        XCTAssertEqual(origin.crash.native?.framesIncomplete, false)
    }
    func testLargeImageAndThreadListsDegradeInsteadOfRejecting() throws {
        // UI processes can load more than a thousand images; only referenced images are emitted.
        let many = try XCTUnwrap(decode(record(images: Array(repeating: image(base: 0x9000), count: 1500) + [image()])).crash.native)
        XCTAssertEqual(many.images.count, 1); XCTAssertEqual(many.frames[0].imageIndex, 0)
        XCTAssertEqual(many.frames[0].imageOffset, "0x10"); XCTAssertFalse(many.imagesIncomplete)
        // Up to the recorder's own 1000-thread maximum, the unique crashed thread is found anywhere.
        var threads: [[String: Any]] = (0..<1000).map { ["index": $0, "crashed": false] }
        threads[999] = ["index": 999, "crashed": true, "backtrace": ["contents": [frame()]]]
        XCTAssertEqual(try decode(changeCrash(record(), "threads", threads)).crash.native?.crashedThreadIndex, 999)
    }
    func testRuntimeCrashInfoBecomesRedactedMessage() throws {
        var swift = image(base: 0x180000000, size: 0x100000, uuid: systemID, name: "/usr/lib/swift/libswiftCore.dylib")
        swift["crash_info_message"] = "Feature.swift:42: Fatal error: boom 4111111111111111\n"
        var stale = image(base: 0x190000000, size: 0x1000, uuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "/usr/lib/libStale.dylib")
        stale["crash_info_message"] = "STALE"
        let trap = changeError(record(frames: [frame(pc: 0x180000010), frame()], images: [swift, image(), stale]), "reason", NSNull())
        let crash = try decode(trap, redact: { RedactionEngine().redact($0) }).crash
        XCTAssertEqual(crash.exceptionType, "EXC_BREAKPOINT")
        XCTAssertTrue(crash.message.hasPrefix("Feature.swift:42: Fatal error: boom "), crash.message)
        XCTAssertFalse(crash.message.contains("4111111111111111")); XCTAssertFalse(crash.message.contains("STALE"))
        XCTAssertFalse(crash.message.unicodeScalars.contains { $0.value < 32 })
        // A recorded reason still wins, and a malformed message does not invalidate its image.
        XCTAssertEqual(try decode(record(frames: [frame(pc: 0x180000010)], images: [swift])).crash.message, "failure")
        swift["crash_info_message"] = 7
        let malformed = changeError(record(frames: [frame(pc: 0x180000010)], images: [swift]), "reason", NSNull())
        XCTAssertEqual(try decode(malformed).crash.native?.frames[0].imageIndex, 0)
        XCTAssertEqual(try decode(malformed).crash.message, "EXC_BREAKPOINT")
    }
    func testPreflightCostDoesNotGrowWithAncestorKeys() throws {
        // Deep, long ancestor keys must not multiply the per-number structural path check.
        let key = String(repeating: "k", count: 1024), numbers = Array(repeating: "0", count: 30_000).joined(separator: ",")
        let nested = Data((String(repeating: "{\"" + key + "\":", count: 63) + "[" + numbers + "]" + String(repeating: "}", count: 63)).utf8)
        let flat = Data(("{\"padding\":\"" + String(repeating: "x", count: 63 * 1030) + "\",\"values\":[" + numbers + "]}").utf8)
        func seconds(_ data: Data) throws -> TimeInterval {
            let start = Date(); try NativeCrashJSONPreflight.validate(data); return Date().timeIntervalSince(start)
        }
        _ = try seconds(flat)
        let baseline = try seconds(flat), elapsed = try seconds(nested)
        XCTAssertLessThan(elapsed, max(baseline, 0.01) * 20, "nested \(elapsed)s, flat \(baseline)s")
    }
    func testDistinctImagesAssociateDeduplicateAndRemapAfterInvalidEntries() throws {
        let a = "aaaaaaaa-0000-4000-8000-00000000000a", b = "bbbbbbbb-0000-4000-8000-00000000000b"
        let imageA = image(base: 0x1000, uuid: a, name: "/private/var/containers/Bundle/Application/X/App.app/App")
        var imageB = image(base: 0x2000, uuid: b, name: "/private/var/containers/Bundle/Application/X/App.app/Frameworks/Kit.framework/Kit")
        imageB.removeValue(forKey: "image_vmaddr"); imageB["cpu_subtype"] = 2
        let native = try XCTUnwrap(decode(record(frames: [frame(pc: 0x1010), frame(pc: 0x2020), frame(pc: 0x1030)],
                                                 images: [["name": "only-name"], imageA, imageB])).crash.native)
        XCTAssertEqual(native.images.map(\.uuid), [a, b]); XCTAssertEqual(native.images.map(\.name), ["App", "Kit"])
        XCTAssertEqual(native.images.map(\.loadAddress), ["0x1000", "0x2000"]); XCTAssertEqual(native.images.map(\.size), ["0x100", "0x100"])
        XCTAssertEqual(native.images.map(\.vmAddress), ["0x100000000", nil]); XCTAssertEqual(native.images.map(\.cpuType), [16777228, 16777228])
        XCTAssertEqual(native.images.map(\.cpuSubtype), [0, 2]); XCTAssertEqual(native.images.map(\.architecture), [.arm64, .arm64E])
        XCTAssertEqual(native.frames.map(\.imageIndex), [0, 1, 0]); XCTAssertEqual(native.frames.map(\.imageOffset), ["0x10", "0x20", "0x30"])
        XCTAssertTrue(native.imagesIncomplete)
    }
}
