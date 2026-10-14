// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Testing
import Foundation
import EverframeProtocol
@testable import EverframeKit
struct StateRecorderTests {
    private func make() -> StateRecorder {
        let r = StateRecorder(now: { 1001 }, sequence: EvidenceSequence())
        r.reset(initial: EverframeStateSnapshot(automatic: [:], custom: [:]), startedAt: 1000)
        return r
    }
    private func json(_ state: EverframeReportState?) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as! [String: Any]
    }
    @Test func sharedWireFixtureReplaysWithNativePrimitiveTypes() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let fixture = try JSONDecoder().decode(EverframeReportState.self, from: Data(contentsOf: root.appendingPathComponent("protocol/__tests__/fixtures/state.v1.json")))
        let r = make(); r.reset(initial: fixture.initial, startedAt: fixture.startedAt)
        for change in fixture.changes {
            if let value = change.value { r.set(change.key, value: value, namespace: change.namespace) }
            else { r.clear(change.key, namespace: change.namespace) }
        }
        let current = try #require(r.snapshot(capturedAt: fixture.capturedAt)).current
        #expect(try EnvelopeBuilder.makeJSONEncoder().encode(current) == EnvelopeBuilder.makeJSONEncoder().encode(fixture.current))
    }
    @Test func concurrentWritesPreserveFrozenState() throws {
        let r = make()
        DispatchQueue.concurrentPerform(iterations: 100) { index in _ = r.set("key\(index % 10)", value: .double(Double(index))) }
        r.freeze(capturedAt: 1002)
        let frozen = try #require(r.takeFrozen())
        DispatchQueue.concurrentPerform(iterations: 100) { index in _ = r.set("key\(index % 10)", value: .double(Double(index + 100))) }
        #expect(frozen.changes.allSatisfy { if case .double(let value) = $0.value { return value < 100 }; return false })
        let sequence = try #require(r.snapshot(capturedAt: 1003)).changes.map(\.seq)
        #expect(zip(sequence, sequence.dropFirst()).allSatisfy { $0 < $1 })
    }
    @Test func typedValuesAndFreeze() throws {
        let r = make()
        #expect(r.set("plan", value: .string("free")))
        #expect(!r.set("plan", value: .string("free")))
        #expect(r.set("enabled", value: .bool(false)))
        #expect(r.set("count", value: .double(0)))
        r.freeze(capturedAt: 1002)
        #expect(r.set("plan", value: .string("premium")))
        let frozen = try json(r.takeFrozen())
        let custom = (frozen["current"] as! [String: Any])["custom"] as! [String: Any]
        #expect(custom["plan"] as? String == "free")
        #expect(custom["enabled"] as? Bool == false)
        #expect(custom["count"] as? Double == 0)
        #expect(r.clear("plan"))
        #expect(!r.clear("plan"))
        #expect(r.snapshot(capturedAt: 1003)?.changes.count == 5)
        r.erase()
        #expect(r.snapshot(capturedAt: 1004) == nil)
        #expect(!r.set("late", value: .bool(true)))
    }
    @Test func boundsAndCheckpoint() throws {
        let r = make()
        for i in 0..<150 { #expect(r.set("count", value: .double(Double(i)))) }
        let s = try #require(r.snapshot(capturedAt: 1003))
        #expect(s.changes.count == 100)
        #expect(s.droppedChanges == 50)
        #expect(s.checkpoint?.throughSeq == 49)
        #expect(s.initial.custom.isEmpty)
        for i in 0..<49 { #expect(r.set("key\(i)", value: .bool(false))) }
        #expect(!r.set("overflow", value: .bool(true)))
        #expect(r.clear("key0"))
        #expect(!r.set("another", value: .bool(true)))
        #expect(r.set("key0", value: .bool(true)))
    }
    @Test func validationAndPrivacy() throws {
        let r = make()
        for key in ["", "__proto__", "bad\u{0}key", String(repeating: "a", count: 65)] {
            #expect(!r.set(key, value: .bool(true)))
        }
        #expect(!r.set("nan", value: .double(.nan)))
        #expect(!r.set("long", value: .string(String(repeating: "a", count: 257))))
        #expect(r.set("apiKey", value: .double(123)))
        #expect(r.set("empty", value: .string("")))
        let custom = (try json(r.snapshot(capturedAt: 1003))["current"] as! [String: Any])["custom"] as! [String: Any]
        #expect(custom["apiKey"] as? String == "[REDACTED]")
        #expect(custom["empty"] as? String == "")
    }
    @Test func sharedOrderingAndCancel() throws {
        let sequence = EvidenceSequence()
        let r = StateRecorder(now: { 1000 }, sequence: sequence)
        r.reset(initial: EverframeStateSnapshot(automatic: [:], custom: [:]), startedAt: 1000)
        #expect(r.set("one", value: .bool(true)))
        let between = sequence.next()
        #expect(r.set("two", value: .bool(true)))
        r.freeze(capturedAt: 1001)
        #expect(r.set("three", value: .bool(true)))
        r.discardFrozen()
        #expect(r.takeFrozen() == nil)
        let changes = try #require(r.snapshot(capturedAt: 1002)).changes
        #expect(changes[0].seq < between && changes[1].seq > between)
        #expect(changes.count == 3)
    }
    @Test func slashEscapingUsesEnvelopeBudget() throws {
        let r = make()
        for i in 0..<50 { _ = r.set("key\(i)", value: .string(String(repeating: "/", count: 256))) }
        let s = try #require(r.snapshot(capturedAt: 1003))
        #expect(try EnvelopeBuilder.makeJSONEncoder().encode(s.current.custom).count <= 8192)
        #expect(try EnvelopeBuilder.makeJSONEncoder().encode(s).count <= 32768)
    }
    @Test func wireByteBudget() throws {
        let r = make()
        for i in 0..<50 { _ = r.set("key\(i)", value: .string(String(repeating: "😀", count: 128))) }
        let state = try #require(r.snapshot(capturedAt: 1003))
        #expect(try JSONEncoder().encode(state.current.custom).count <= 8192)
        for i in 0..<200 { _ = r.set("key0", value: .string(String(repeating: "😀", count: 120) + "\(i)")) }
        #expect(try JSONEncoder().encode(r.snapshot(capturedAt: 1004)).count <= 32768)
    }
}
