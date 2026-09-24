// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation
import Testing
@testable import EverframeKit

private actor FinalizationGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var released = false
    func wait() async {
        if released { return }
        await withCheckedContinuation { continuation = $0 }
    }
    func release() { released = true; continuation?.resume(); continuation = nil }
}

@MainActor struct NativeVideoFinalizationTests {
    @Test func cancelledConsumerCannotTakeCompletedArtifact() async throws {
        let file = try artifact(); defer { try? FileManager.default.removeItem(at: file.url) }
        let deadline = FinalizationGate()
        let consumerGate = FinalizationGate()
        let job = NativeVideoFinalization(operation: { file }, cancelOperation: {},
            deadline: { await deadline.wait() })
        let consumer = Task { await consumerGate.wait(); return await job.take() }
        consumer.cancel()
        await consumerGate.release()
        #expect(await consumer.value == nil)
        await deadline.release()
        try await expectRemoved(file.url)
    }
    private func expectRemoved(_ url: URL) async throws {
        let deadline = DispatchTime.now().uptimeNanoseconds + 2_000_000_000
        while FileManager.default.fileExists(atPath: url.path), DispatchTime.now().uptimeNanoseconds < deadline {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        #expect(!FileManager.default.fileExists(atPath: url.path))
    }
    private func artifact() throws -> NativeVideoArtifact {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        try Data([1, 2, 3]).write(to: url)
        return .init(url: url, byteCount: 3, startEpochMs: 1000, durationMs: 200, width: 64, height: 64)
    }
    @Test func successfulResultCanOnlyBeTakenOnce() async throws {
        let file = try artifact(); defer { try? FileManager.default.removeItem(at: file.url) }
        let deadline = FinalizationGate()
        let job = NativeVideoFinalization(operation: { file }, cancelOperation: {},
            deadline: { await deadline.wait() })
        let result = await job.take()
        #expect(result?.url == file.url)
        #expect(await job.take() == nil)
        job.cancel()
        #expect(FileManager.default.fileExists(atPath: file.url.path))
        await deadline.release()
    }
    @Test func deadlineReturnsWithoutWaitingForUncooperativeEncoder() async throws {
        let file = try artifact(); defer { try? FileManager.default.removeItem(at: file.url) }
        let encoder = FinalizationGate()
        let deadline = FinalizationGate()
        let job = NativeVideoFinalization(operation: { await encoder.wait(); return file }, cancelOperation: {},
            deadline: { await deadline.wait() })
        await deadline.release()
        #expect(await job.take() == nil)
        #expect(job.omissionReason == "finalization_timeout")
        await encoder.release()
        try await expectRemoved(file.url)
    }
    @Test func cancellationDiscardsLateArtifact() async throws {
        let file = try artifact(); defer { try? FileManager.default.removeItem(at: file.url) }
        let encoder = FinalizationGate()
        let deadline = FinalizationGate()
        let job = NativeVideoFinalization(operation: { await encoder.wait(); return file }, cancelOperation: {},
            deadline: { await deadline.wait() })
        job.cancel()
        #expect(await job.take() == nil)
        await encoder.release(); await deadline.release()
        try await expectRemoved(file.url)
    }
}
#endif
