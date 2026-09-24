// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Twin of VitalsCollectorTest.kt — case for case. Host-runnable.
import XCTest
import EverframeProtocol
@testable import EverframeKit

final class FakeScheduler: VitalsScheduler, @unchecked Sendable {
    var tick: (@Sendable () -> Void)?
    var closed = false
    final class Handle: VitalsCancellable, @unchecked Sendable {
        let onCancel: () -> Void
        init(_ onCancel: @escaping () -> Void) { self.onCancel = onCancel }
        func cancel() { onCancel() }
    }
    func repeating(intervalMs: Int64, _ tick: @escaping @Sendable () -> Void) -> VitalsCancellable {
        self.tick = tick
        return Handle { [self] in self.closed = true; self.tick = nil }
    }
    func fire() { tick?() }
}

final class VitalsCollectorTests: XCTestCase {
    private let dims = SessionSummaryDims(platform: "ios", appVersion: "1", sdkVersion: "0.7.0")
    private var now: Int64 = 1_000_000
    private var sent: [VitalsIngestPayload] = []
    private var scheduler = FakeScheduler()
    private var ids = 0

    override func setUp() {
        super.setUp()
        InternalLogger.drainFailures()
        now = 1_000_000; sent = []; scheduler = FakeScheduler(); ids = 0
    }

    private func collector(
        send: (@Sendable (VitalsIngestPayload) -> Void)? = nil,
        maxBufferBytes: Int = 65_536,
        maxEntriesPerChunk: Int = 50,
        maxSeq: Int = VitalsLimits.maxSeq,
        summaryEveryChunks: Int = 5,
        onRotate: (@Sendable (VitalsEntry?) -> Void)? = nil
    ) -> VitalsCollector {
        let box = self
        return VitalsCollector(deps: VitalsCollector.Deps(
            dims: dims,
            now: { box.now },
            send: { p in if let send { send(p) } else { box.sent.append(p) } },
            newSessionId: { defer { box.ids += 1 }; return "sid-\(box.ids)" },
            scheduler: scheduler,
            maxEntriesPerChunk: maxEntriesPerChunk,
            maxBufferBytes: maxBufferBytes,
            summaryEveryChunks: summaryEveryChunks,
            maxSeq: maxSeq,
            onRotate: onRotate))
    }
    private func sample(mem: Int64 = 1) -> VitalsSample { VitalsSample(t: now, mem: mem) }

    /// A TRANSPORTED entry. Samples feed the accumulator and count as activity
    /// but never reach the chunk queue or the recent ring (see
    /// `VitalsCollector.addEntry`), so every test about chunking, flushing,
    /// the ring or the stamp drives one of these instead.
    private func event(_ n: Int = 1) -> VitalsPlayerEvent {
        VitalsPlayerEvent(t: now, type: "seek", data: ["n": .int(Int64(n))])
    }
    private var chunks: [VitalsChunk] { sent.compactMap { if case let .chunk(c) = $0 { return c }; return nil } }
    private var summaries: [SessionSummary] { sent.compactMap { if case let .summary(s) = $0 { return s }; return nil } }

    func testSendsAnInitialNonFinalSummaryOnCreation() {
        _ = collector()
        XCTAssertEqual(sent.count, 1)
        let s = summaries[0]
        XCTAssertFalse(s.final); XCTAssertEqual(s.seq, 0); XCTAssertEqual(s.sessionId, "sid-0")
    }

    func testFlushesAChunkAt50EntriesWithoutTheTimer() {
        let c = collector()
        for _ in 0..<49 { c.recordPlayerEvent(event()) }
        XCTAssertEqual(chunks.count, 0)
        c.recordPlayerEvent(event())
        XCTAssertEqual(chunks.count, 1); XCTAssertEqual(chunks[0].entries.count, 50); XCTAssertEqual(chunks[0].seq, 0)
    }

    func testFlushesOnTheIntervalTickAndIncrementsSeqNothingWhenEmpty() {
        let c = collector()
        c.recordPlayerEvent(event()); scheduler.fire()
        c.recordPlayerEvent(event()); scheduler.fire()
        scheduler.fire()
        XCTAssertEqual(chunks.map(\.seq), [0, 1])
    }

    func testSendsAFreshNonFinalSummaryAfterEvery5thChunkWithIncreasingSeq() {
        let c = collector()
        for _ in 0..<10 { c.recordPlayerEvent(event()); scheduler.fire() }
        XCTAssertEqual(chunks.count, 10)
        XCTAssertEqual(summaries.map(\.seq), [0, 1, 2])
        XCTAssertTrue(summaries.allSatisfy { !$0.final })
    }

    func testTheByteCapFlushesBeforeAdmittingSoNothingAlreadyAcceptedIsDeleted() {
        // Android codex round-2, Important 8 — the buffer is SENT and the
        // entry admitted into the empty one; nothing accepted is ever evicted.
        let c = collector(maxBufferBytes: 4096)
        let big = VitalsPlayerEvent(t: now, type: "error", playerId: "p1", data: ["message": .string(String(repeating: "x", count: 1500))])
        c.recordPlayerEvent(big); c.recordPlayerEvent(big)
        XCTAssertEqual(chunks.count, 0)
        c.recordPlayerEvent(big)   // third does not fit → first two flushed, third admitted alone
        XCTAssertEqual(chunks.count, 1); XCTAssertEqual(chunks[0].entries.count, 2)
        c.flushNow()
        XCTAssertEqual(chunks.count, 2); XCTAssertEqual(chunks[1].entries.count, 1)
        XCTAssertEqual(c.recent().count, 3)
        XCTAssertEqual(summaries.last?.errorCount, 3)
    }

    func testAnEntryTooLargeToFitEvenAloneIsDroppedFromTheRingAndTheSummaryToo() {
        let c = collector(maxBufferBytes: 512)
        let huge = VitalsPlayerEvent(t: now, type: "error", playerId: "p1", data: ["message": .string(String(repeating: "x", count: 5000))])
        XCTAssertFalse(c.recordPlayerEvent(huge))
        XCTAssertEqual(c.recent().count, 0)
        c.flushNow()
        XCTAssertEqual(chunks.count, 0); XCTAssertEqual(summaries.last?.errorCount, 0)
    }

    func testAChunkFarFromTheByteCapNeverPaysForTheExactFramedEncode() {
        let c = collector()
        for _ in 0..<40 { c.recordPlayerEvent(event()) }
        XCTAssertEqual(c.exactCostCalls, 0)
    }

    func testTheRunningEstimateStillHonoursTheCapOnceEntriesApproachTheBudget() {
        let c = collector(maxBufferBytes: 8192, maxEntriesPerChunk: 1000)
        let e = VitalsPlayerEvent(t: now, type: "error", playerId: "p1", data: ["message": .string(String(repeating: "x", count: 900))])
        for _ in 0..<12 { c.recordPlayerEvent(e) }
        XCTAssertGreaterThan(c.exactCostCalls, 0)
        for chunk in chunks {
            XCTAssertLessThanOrEqual(try! VitalsWireCodec.encodeRequest(.chunk(chunk)).count, 8192)
        }
    }

    func testMeasuresTheCapInUTF8Bytes() {
        let c = collector(maxBufferBytes: 1024, maxEntriesPerChunk: 1000)
        let e = VitalsPlayerEvent(t: now, type: "error", playerId: "p1", data: ["message": .string(String(repeating: "😀", count: 100))]) // 400 bytes, 100 chars
        c.recordPlayerEvent(e); c.recordPlayerEvent(e)
        XCTAssertEqual(chunks.count, 1)   // two 400+-byte entries do not fit in 1024 - 32
    }

    func testRecentReturnsARingIndependentOfFlushingAndPrunesToTheWindow() {
        let c = collector()
        c.recordPlayerEvent(event()); scheduler.fire()
        XCTAssertEqual(c.recent().count, 1)
        now += 61_000
        XCTAssertEqual(c.recent().count, 0)
    }

    func testIdleGapOver30MinutesFinalizesAtTheLastEntryRotatesThenRecordsTheTrigger() {
        let c = collector()
        c.recordPlayerEvent(event())
        let lastT = now
        now += 31 * 60_000
        c.recordPlayerEvent(event())
        XCTAssertEqual(c.sessionId, "sid-1")
        // finalize: chunk seq 0 (1 entry) + final summary for sid-0, then the initial summary for sid-1
        XCTAssertEqual(chunks.count, 1); XCTAssertEqual(chunks[0].sessionId, "sid-0"); XCTAssertEqual(chunks[0].entries.count, 1)
        let finals = summaries.filter(\.final)
        XCTAssertEqual(finals.count, 1); XCTAssertEqual(finals[0].sessionId, "sid-0"); XCTAssertEqual(finals[0].durationMs, lastT - 1_000_000)
        XCTAssertEqual(summaries.last?.sessionId, "sid-1"); XCTAssertFalse(summaries.last!.final)
        c.flushNow()
        XCTAssertEqual(chunks.last?.sessionId, "sid-1"); XCTAssertEqual(chunks.last?.entries.count, 1)
    }

    func testMaxAgeRotationFinalizesWithDurationMsExactlyMaxSessionMs() {
        // Twin of Kotlin's arrangement exactly: no seeding recordSample before the
        // jump. The brief's literal included one, which also seeds `lastEntryAt`
        // and trips the idle-gap check (checked before max-age in `addEntry`),
        // making the rotation finalize at the wrong timestamp (durationMs 0).
        let c = collector()
        now += 24 * 60 * 60_000
        c.recordPlayerEvent(event())
        XCTAssertEqual(summaries.first(where: \.final)?.durationMs, 24 * 60 * 60_000)
        XCTAssertEqual(c.sessionId, "sid-1")
    }

    func testStopFlushesPendingSendsAFinalSummaryAndLaterCallsAreNoOps() {
        let c = collector()
        c.recordPlayerEvent(event())
        c.stop()
        XCTAssertEqual(chunks.count, 1); XCTAssertTrue(summaries.last!.final); XCTAssertTrue(scheduler.closed)
        let count = sent.count
        c.stop(); c.recordPlayerEvent(event()); c.flushNow(); scheduler.fire()
        XCTAssertEqual(sent.count, count)
    }

    func testFlushNowSendsPendingChunkPlusANonFinalSummary() {
        let c = collector()
        c.recordPlayerEvent(event()); c.flushNow()
        XCTAssertEqual(chunks.count, 1); XCTAssertEqual(summaries.count, 2); XCTAssertFalse(summaries[1].final)
    }

    func testASendThatDropsItsPayloadNeverStallsLaterFlushes() {
        // Swift closures cannot throw into the collector; the Kotlin "throwing send" cases guard
        // send-before-advance ordering. Here a send that records nothing on its first call must
        // leave every later tick flushing normally with monotonic seq.
        let first = Locked(true)
        let c = collector(send: { [self] p in
            if first.value { first.mutate { $0 = false }; return }
            self.sent.append(p)
        })
        c.recordPlayerEvent(event()); scheduler.fire()
        c.recordPlayerEvent(event()); scheduler.fire()
        XCTAssertEqual(chunks.map(\.seq), [0, 1])
    }

    func testCapsTheRingAt800EntriesDuringAStorm() {
        let c = collector(maxEntriesPerChunk: 100_000)
        for _ in 0..<1000 { c.recordPlayerEvent(event()) }
        XCTAssertEqual(c.stamp().entries.count, 800)
        // Round-1, O12: the ring holds 800, but a `recent()` read is capped at the same
        // 400 the envelope's stamp site applies — the spec's limit for an enriched report.
        XCTAssertEqual(c.recent().count, VitalsLimits.maxEnvelopeVitalsEntries)
    }

    // Codex round-6, W6-I3 — the ring is in ARRIVAL order but `t` is the caller's TRANSITION
    // time, so an expired entry can sit anywhere in it. Pruning an expired PREFIX stopped at the
    // first fresh entry and left the stale one in the crash stamp.
    func testPrunesAnExpiredEntryThatArrivedAfterAFreshOne() {
        let c = collector(maxEntriesPerChunk: 100_000)
        c.recordPlayerEvent(VitalsPlayerEvent(t: now, type: "play", playerId: "p1"))
        // A player outbox that stalled drains an event stamped at its own, much older transition.
        c.recordPlayerEvent(VitalsPlayerEvent(t: now - 100_000, type: "pause", playerId: "p1"))
        let entries = c.recent()
        XCTAssertEqual(entries.count, 1)
        guard case let .player(p)? = entries.first else { return XCTFail() }
        XCTAssertEqual(p.type, "play")
    }

    // The same defect's worse half: `recent()` takes the NEWEST 400 arrivals, so a stale backlog
    // that prefix-pruning could not delete displaced the evidence that describes the crash.
    func testADelayedBacklogCannotDisplaceFreshEvidenceFromTheRecentWindow() {
        let c = collector(maxEntriesPerChunk: 100_000)
        c.recordPlayerEvent(VitalsPlayerEvent(t: now, type: "play", playerId: "p1"))
        for _ in 0..<VitalsLimits.maxEnvelopeVitalsEntries {
            c.recordPlayerEvent(VitalsPlayerEvent(t: now - 100_000, type: "pause", playerId: "p1"))
        }
        let entries = c.recent()
        XCTAssertEqual(entries.count, 1)
        guard case let .player(p)? = entries.first else { return XCTFail() }
        XCTAssertEqual(p.type, "play")
    }

    func testBoundsAnOversizedPlayerPayloadButKeepsScalars() {
        let c = collector()
        let e = VitalsPlayerEvent(t: now, type: "error", playerId: "p1", data: ["message": .string(String(repeating: "m", count: 20_000)), "fatal": .bool(true), "code": .int(7)])
        XCTAssertTrue(c.recordPlayerEvent(e))
        guard case let .player(recorded)? = c.recent().first else { return XCTFail() }
        XCTAssertEqual(recorded.truncated, true)
        XCTAssertEqual(recorded.data?["fatal"], .bool(true)); XCTAssertEqual(recorded.data?["code"], .int(7))
        XCTAssertLessThanOrEqual(encodedJSONText(.object(recorded.data!)).utf8.count, VitalsLimits.maxPlayerEventDataBytes)
    }

    func testCustomEntriesBufferAndFlushWithKindCustom() {
        let c = collector()
        c.recordCustom(VitalsCustomEntry(t: now, name: "ad", data: .object(["a": .int(1)])))
        c.flushNow()
        guard case .custom = chunks[0].entries[0] else { return XCTFail() }
    }

    func testRecentTimesOutInsteadOfBlockingWhenAnotherThreadHoldsTheLockAndSessionIdStillReads() {
        let hold = DispatchSemaphore(value: 0), held = DispatchSemaphore(value: 0)
        let c = collector(send: { [self] p in
            self.sent.append(p)
            if case .chunk = p { held.signal(); hold.wait() }   // `send` runs under the collector lock
        })
        c.recordPlayerEvent(event())
        DispatchQueue.global().async { c.flushNow() }
        held.wait()
        let t0 = Date()
        XCTAssertEqual(c.recent(lockTimeoutMs: 100), [])
        XCTAssertLessThan(Date().timeIntervalSince(t0), 2.0)
        XCTAssertEqual(c.sessionId, "sid-0")
        hold.signal()
    }

    func testOnRotateRunsWithTheCollectorLockReleased() {
        let cBox = Locked<VitalsCollector?>(nil)
        let sawRing = Locked<[VitalsEntry]?>(nil)
        let c = collector(onRotate: { _ in sawRing.mutate { $0 = cBox.value?.recent() } })   // re-entering recent() would deadlock under the lock
        cBox.mutate { $0 = c }
        c.recordPlayerEvent(event()); now += 31 * 60_000; c.recordPlayerEvent(event())
        XCTAssertNotNil(sawRing.value)
    }

    func testOnRotateReceivesTheEntryThatTriggeredTheRotation() {
        let trigger = Locked<VitalsEntry??>(nil)
        let c = collector(onRotate: { entry in trigger.mutate { $0 = .some(entry) } })
        c.recordPlayerEvent(event()); now += 31 * 60_000
        let s = sample(mem: 42); c.recordSample(s)
        XCTAssertEqual(trigger.value, .some(.sample(s)))
    }

    func testTheSessionRotatesBeforeEitherSequenceCounterCanExceedTheProtocolMaximum() {
        let c = collector(maxSeq: 5)
        for _ in 0..<10 { c.recordPlayerEvent(event()); scheduler.fire() }
        XCTAssertTrue(chunks.allSatisfy { $0.seq < 5 }); XCTAssertTrue(summaries.allSatisfy { $0.seq < 5 })
        XCTAssertGreaterThan(Set(chunks.map(\.sessionId)).count, 1)
    }

    func testABackgroundFlushRotatesBeforeTheSummarySequenceCanExceedTheCap() {
        let c = collector(maxSeq: 3)
        for _ in 0..<6 { c.flushNow() }     // each flushNow sends a summary (summarySeq++) with no entries
        XCTAssertTrue(summaries.allSatisfy { $0.seq < 3 })
    }

    func testStopClearsTheRecentRing() {
        let c = collector(); c.recordPlayerEvent(event()); c.stop()
        XCTAssertEqual(c.recent(), [])
    }

    func testStampTakesTheSessionIdAndTheRingUnderOneLockAcquisition() {
        let c = collector(); c.recordPlayerEvent(event())
        let s = c.stamp()
        XCTAssertEqual(s.sessionId, "sid-0"); XCTAssertEqual(s.entries.count, 1)
    }

    func testStampGivesUpOnAHeldLockAndStillReportsTheSessionId() {
        let hold = DispatchSemaphore(value: 0), held = DispatchSemaphore(value: 0)
        let c = collector(send: { [self] p in self.sent.append(p); if case .chunk = p { held.signal(); hold.wait() } })
        c.recordPlayerEvent(event())
        DispatchQueue.global().async { c.flushNow() }
        held.wait()
        let s = c.stamp(lockTimeoutMs: 50)
        XCTAssertEqual(s.sessionId, "sid-0"); XCTAssertEqual(s.entries, [])
        hold.signal()
    }

    func testADeferredRecordHandsItsRotationBackUnfired() {
        let fired = Locked(0)
        let c = collector(onRotate: { _ in fired.mutate { $0 += 1 } })
        c.recordPlayerEvent(event()); now += 31 * 60_000
        let rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "player_attach", playerId: "p1"))
        XCTAssertEqual(fired.value, 0); XCTAssertTrue(rec.accepted); XCTAssertEqual(rec.sessionId, "sid-1")
        rec.fireRotate(); XCTAssertEqual(fired.value, 1)
        rec.fireRotate(); XCTAssertEqual(fired.value, 1)   // one-shot
    }

    func testAStoppedCollectorAcceptsNothing() {
        let c = collector(); c.stop()
        let rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "play", playerId: "p1"))
        XCTAssertFalse(rec.accepted); XCTAssertNil(rec.sessionId)
    }

    func testAnEntryExpectingASessionTheCollectorHasLeftIsRefusedOutright() {
        let c = collector()
        c.recordPlayerEvent(event()); now += 31 * 60_000; c.recordPlayerEvent(event())   // now sid-1
        let rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "play", playerId: "p1"), expectedSessionId: "sid-0")
        XCTAssertFalse(rec.accepted)
    }

    func testAPinnedEntryThatWouldRotateTheSessionIsRefusedNotCarriedAcross() {
        // Android codex round-6, #3: a pin means "this session or nowhere".
        let c = collector()
        c.recordPlayerEvent(event()); now += 31 * 60_000
        let rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "player_detach", playerId: "p1"), expectedSessionId: "sid-0")
        XCTAssertFalse(rec.accepted); XCTAssertEqual(c.sessionId, "sid-0")   // nothing rotated
    }

    func testAnUnpinnedEntryStillRotatesAndLandsInTheNewSession() {
        let c = collector()
        c.recordPlayerEvent(event()); now += 31 * 60_000
        let rec = c.recordCustomDeferred(VitalsCustomEntry(t: now, name: "n"))
        XCTAssertTrue(rec.accepted); XCTAssertEqual(rec.sessionId, "sid-1"); XCTAssertEqual(c.sessionId, "sid-1")
    }

    func testAnEntryTheTransportRefusesForSizeIsNotAccepted() {
        let c = collector(maxBufferBytes: 256)
        let rec = c.recordCustomDeferred(VitalsCustomEntry(t: now, name: "n", data: .string(String(repeating: "x", count: 2000))))
        XCTAssertFalse(rec.accepted); XCTAssertNil(rec.sessionId)
    }

    // MARK: - Remaining Kotlin cases (mechanical port, same harness/assertions)

    func testStopClearsTheRecentRingEvenWhenTheFinalSendDoesNothing() {
        // Twin of Kotlin's "...even when the final send throws". Swift closures
        // cannot throw into the collector, so the port is a send that records
        // the call and then does nothing on later calls.
        let calls = Locked(0)
        let c = collector(send: { _ in calls.mutate { $0 += 1 } })
        c.recordPlayerEvent(event())
        c.stop()
        XCTAssertEqual(c.recent(), [])
        XCTAssertGreaterThan(calls.value, 0)
    }

    func testOnRotateFiresOncePerRotationAfterTheNewSessionExistsAndAThrowingOneIsContained() {
        let cBox = Locked<VitalsCollector?>(nil)
        let calls = Locked(0)
        let c = collector(onRotate: { _ in
            calls.mutate { $0 += 1 }
            if calls.value > 1 { XCTFail("onRotate must fire once per rotation") }
            XCTAssertEqual(cBox.value?.sessionId, "sid-1")
        })
        cBox.mutate { $0 = c }
        c.recordPlayerEvent(event()); now += 31 * 60_000; c.recordPlayerEvent(event())
        XCTAssertEqual(calls.value, 1)
        XCTAssertNotEqual(c.sessionId, "sid-0")
        c.recordPlayerEvent(event())
        XCTAssertEqual(c.recent().count, 2)
    }

    func testADeferredRecordWithNoRotationIsANoOpToFire() {
        let rotations = Locked(0)
        let c = collector(onRotate: { _ in rotations.mutate { $0 += 1 } })
        let rec = c.recordCustomDeferred(VitalsCustomEntry(t: now, name: "x"))
        XCTAssertTrue(rec.accepted)
        rec.fireRotate()
        XCTAssertEqual(rotations.value, 0)
    }

    func testAnUNPINNEDEntryThatTriggersARotationReportsTheSessionItLandedIn() {
        // Codex round-6, #3: stated with NO expectedSessionId — player_attach is
        // recorded unpinned, and rec.sessionId must name where it landed.
        let c = collector()
        c.recordCustom(VitalsCustomEntry(t: now, name: "seed"))
        let before = c.sessionId
        now += 31 * 60_000
        let rec = c.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "player_attach", playerId: "p1"))
        XCTAssertTrue(rec.accepted)
        XCTAssertNotEqual(before, c.sessionId)
        XCTAssertEqual(c.sessionId, rec.sessionId)
    }

    func testAPinnedEntryThatWouldRotateOnMaxAgeOrTheSeqCapIsRefusedToo() {
        let byAge = collector()
        let agePin = byAge.sessionId
        now += 24 * 60 * 60_000
        XCTAssertFalse(byAge.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "pause", playerId: "p1"), expectedSessionId: agePin).accepted)
        XCTAssertEqual(byAge.sessionId, agePin)

        // maxSeq = 2 means seq >= 1 already reads as exhausted, so the very
        // first entry after one chunk has gone out would rotate.
        let bySeq = collector(maxEntriesPerChunk: 1, maxSeq: 2)
        bySeq.recordCustom(VitalsCustomEntry(t: now, name: "burn"))
        let seqPin = bySeq.sessionId
        XCTAssertFalse(bySeq.recordPlayerEventDeferred(VitalsPlayerEvent(t: now, type: "pause", playerId: "p1"), expectedSessionId: seqPin).accepted)
        XCTAssertEqual(bySeq.sessionId, seqPin)
    }

    // MARK: - CPU/memory samples feed the summary but are never transported
    //
    // EverframeResource consumption is covered by the report resource window: a
    // 2-second-resolution ring attached to the report or crash that explains
    // it, which is both finer than this 30-second stream and actually aligned
    // to the failure. The API discards `sample` entries on arrival, so
    // shipping them only spends battery and bandwidth. `recordSample` still
    // runs the FULL addEntry path — rotation, lastEntryAt, the accumulator —
    // so session lifetimes and memPeak/memAvg are unchanged.

    func testSamplesNeverReachAChunk() {
        let c = collector()
        for i in 0..<60 { c.recordSample(sample(mem: Int64(1000 + i))) }
        c.flushNow()
        XCTAssertEqual(chunks.count, 0)
    }

    func testSamplesStillFeedMemPeakAndMemAvg() {
        let c = collector()
        c.recordSample(sample(mem: 1000))
        c.recordSample(sample(mem: 3000))
        c.stop()
        XCTAssertEqual(summaries.last?.memPeak, 3000)
        XCTAssertEqual(summaries.last?.memAvg, 2000)
    }

    func testSamplesStayOutOfTheRecentRing() {
        let c = collector()
        c.recordSample(sample(mem: 1000))
        c.recordPlayerEvent(event(7))
        XCTAssertEqual(c.recent().count, 1)
        if case .player(let p) = c.recent()[0] {
            XCTAssertEqual(p.type, "seek")
        } else {
            XCTFail("the ring must hold only the player event")
        }
    }

    func testPlayerEventsStillTransportAlongsideDroppedSamples() {
        let c = collector()
        c.recordSample(sample(mem: 1000))
        c.recordPlayerEvent(event(1))
        c.recordSample(sample(mem: 2000))
        c.recordPlayerEvent(event(2))
        c.flushNow()
        XCTAssertEqual(chunks.flatMap { $0.entries }.count, 2)
    }

    func testKeepsSendingPeriodicSummariesForASessionWithNoPlaybackActivity() {
        // The periodic summary used to ride on sendChunk's counter, and
        // sendChunk returns early on an empty buffer. Once samples stopped
        // being transported, a sampling-only session sent NO periodic
        // summaries: memPeak/memAvg reached the server only on a clean stop,
        // and lastSeenAt stopped advancing while the session was still live.
        let c = collector()
        c.recordSample(sample(mem: 1000))
        c.recordSample(sample(mem: 3000))
        for _ in 0..<5 { scheduler.fire() }
        XCTAssertEqual(summaries.count, 2) // initial + one periodic
        XCTAssertEqual(summaries.last?.final, false)
        XCTAssertEqual(summaries.last?.memPeak, 3000)
        XCTAssertEqual(chunks.count, 0)
    }

    func testStaysSilentWhenNothingAtAllHasBeenRecorded() {
        _ = collector()
        for _ in 0..<20 { scheduler.fire() }
        XCTAssertEqual(summaries.count, 1) // just the initial announcement
    }

    func testAnEntryAdmittedAfterAMidAddEntryFlushStillMarksTheSummaryDirty() {
        // FLUSH BEFORE ADMIT: an entry that does not fit the current buffer
        // makes addEntry send the buffer as its own chunk, and that send
        // advances the summary cadence — potentially emitting a summary —
        // BEFORE the triggering entry has reached the accumulator. Marking
        // the session dirty early meant that summary cleared the flag, so the
        // entry's own contribution had nothing left to push it out.
        let c = collector(maxBufferBytes: 4096, summaryEveryChunks: 1)
        let big = VitalsPlayerEvent(
            t: now, type: "error", playerId: "p1",
            data: ["message": .string(String(repeating: "x", count: 1500))])
        c.recordPlayerEvent(big)
        c.recordPlayerEvent(big)
        let before = summaries.count
        c.recordPlayerEvent(big) // does not fit -> flush, summary, then admit

        scheduler.fire()
        XCTAssertGreaterThanOrEqual(summaries.count, before + 2)
    }
}
