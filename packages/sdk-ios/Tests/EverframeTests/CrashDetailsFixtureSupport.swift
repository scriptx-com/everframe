// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
#if canImport(AppKit)
import AppKit
#endif
import XCTest
@testable import EverframeKit
import EverframeProtocol

enum CrashDetailsFixtureSupport {
    struct Fixture {
        let name: String
        let options: CaptureExceptionOptions
        let expected: NSDictionary
    }

    static func encoded(_ options: CaptureExceptionOptions?, redact: (String) throws -> String = { $0 }) throws -> Data {
        try EnvelopeBuilder.makeJSONEncoder().encode(normalizeCrashDetails(options, redact: redact))
    }

    static func object(_ options: CaptureExceptionOptions?, redact: (String) throws -> String = { $0 }) throws -> [String: Any] {
        let bytes = try encoded(options, redact: redact)
        XCTAssertLessThanOrEqual(bytes.count, 8192)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    }

    // Foundation's JSON parser rejects the shared raw lone surrogate. Transcode
    // only that escape, restoring its exact NSString units before projection.
    static func sharedFixtures() throws -> [Fixture] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("protocol/__tests__/fixtures/crash-details-native-parity.json")
        let raw = try String(contentsOf: url, encoding: .utf8)
        let sentinel = "EVERFRAME_TEST_LONE_SURROGATE_7F52"
        XCTAssertFalse(raw.contains(sentinel))
        XCTAssertEqual(raw.components(separatedBy: "\\ud800").count - 1, 1)
        let adapted = raw.replacingOccurrences(of: "\\ud800", with: sentinel)
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(adapted.utf8)) as? [String: Any])
        let cases = try XCTUnwrap(root["cases"] as? [[String: Any]])
        var reconstructed = 0
        func restore(_ value: Any) -> Any {
            if let text = value as? String, text.contains(sentinel) {
                let parts = text.components(separatedBy: sentinel)
                var units: [UInt16] = []
                for (index, part) in parts.enumerated() {
                    if index > 0 { units.append(0xd800); reconstructed += 1 }
                    units.append(contentsOf: part.utf16)
                }
                let string = NSString(characters: units, length: units.count)
                XCTAssertEqual((0..<string.length).map { string.character(at: $0) }, units)
                return string
            }
            if let map = value as? [String: Any] { return map.mapValues(restore) }
            if let array = value as? [Any] { return array.map(restore) }
            return value
        }
        let fixtures = try cases.map { item in
            let input = try XCTUnwrap(restore(try XCTUnwrap(item["input"])) as? [String: Any])
            return Fixture(name: try XCTUnwrap(item["name"] as? String),
                options: CaptureExceptionOptions(
                    severity: (input["severity"] as? String).flatMap(EverframeKit.EverframeErrorSeverity.init(rawValue:)) ?? .error,
                    context: input["context"] as? String, metadata: input["metadata"] as? [String: Any]),
                expected: try XCTUnwrap(item["expected"] as? NSDictionary))
        }
        XCTAssertEqual(reconstructed, 1)
        let repaired = try XCTUnwrap(fixtures.first { $0.name == "repaired-text" })
        let malformed = try XCTUnwrap(repaired.options.metadata?["unsafe\0key"] as? NSString)
        XCTAssertEqual((0..<malformed.length).map { malformed.character(at: $0) },
                       [108, 101, 102, 116, 0, 0xd800, 114, 105, 103, 104, 116])
        return fixtures
    }
}

// Real Foundation primitive overrides make access observable without eagerly
// constructing a large collection or asking the projector to describe objects.
final class CrashCountedArray: NSArray {
    var reads = 0
    var size = 0
    var read: (Int) -> Any = { _ in NSNull() }
    override init() { super.init() }
    convenience init(count: Int, read: @escaping (Int) -> Any) {
        self.init()
        self.size = count; self.read = read
    }
    override var count: Int { size }
    override func object(at index: Int) -> Any { reads += 1; return read(index) }
    override init(objects: UnsafePointer<AnyObject>?, count: Int) { fatalError("unused") }
    required init?(coder: NSCoder) { fatalError("unused") }
}

final class CrashCountedDictionary: NSDictionary {
    var keyReads = 0
    var valueReads: [String] = []
    var keysInOrder: [Any] = []
    var read: (String) -> Any? = { _ in nil }
    override init() { super.init() }
    convenience init(keys: [Any], read: @escaping (String) -> Any?) {
        self.init()
        self.keysInOrder = keys; self.read = read
    }
    override var count: Int { keysInOrder.count }
    override func keyEnumerator() -> NSEnumerator { Keys(owner: self) }
    override func object(forKey key: Any) -> Any? {
        guard let key = key as? String else { XCTFail("non-string lookup"); return nil }
        valueReads.append(key)
        return read(key)
    }
    override init(objects: UnsafePointer<AnyObject>?, forKeys keys: UnsafePointer<NSCopying>?, count: Int) { fatalError("unused") }
    required init?(coder: NSCoder) { fatalError("unused") }
    private final class Keys: NSEnumerator {
        let owner: CrashCountedDictionary
        var index = 0
        init(owner: CrashCountedDictionary) { self.owner = owner; super.init() }
        override func nextObject() -> Any? {
            guard index < owner.keysInOrder.count else { return nil }
            defer { index += 1 }
            owner.keyReads += 1
            return owner.keysInOrder[index]
        }
    }
}

final class CrashCountedString: NSString {
    var size = 0
    var reads = 0
    var unitAt: (Int) -> unichar = { _ in 0x61 }
    override init() { super.init() }
    required init?(coder: NSCoder) { fatalError("unused") }
    #if canImport(AppKit)
    required init?(pasteboardPropertyList propertyList: Any, ofType type: NSPasteboard.PasteboardType) { fatalError("unused") }
    #endif
    convenience init(count: Int) { self.init(); size = count }
    override var length: Int { size }
    override func character(at index: Int) -> unichar { reads += 1; return unitAt(index) }
}
