// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
#if canImport(UIKit)
import Foundation

/// Single-consumer handoff with a hard response deadline. A non-cooperative
/// encoder can finish later, but it cannot delay submission or leak its file.
@MainActor final class NativeVideoFinalization {
    private var operationTask: Task<Void, Never>?
    private var deadlineTask: Task<Void, Never>?
    private var waiter: CheckedContinuation<NativeVideoArtifact?, Never>?
    private var completed = false
    private var consumed = false
    private var artifact: NativeVideoArtifact?
    private let cancelOperation: @Sendable () async -> Void
    private(set) var omissionReason: String?

    init(operation: @escaping @Sendable () async throws -> NativeVideoArtifact?,
         cancelOperation: @escaping @Sendable () async -> Void,
         deadline: @escaping @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 5_000_000_000) }) {
        self.cancelOperation = cancelOperation
        operationTask = Task { [weak self] in
            do {
                let artifact = try await operation()
                guard let self else {
                    artifact?.removeOwnedFile()
                    return
                }
                self.resolve(artifact, reason: artifact == nil ? "empty_recording" : nil)
            } catch { self?.resolve(nil, reason: "finalization_failed") }
        }
        deadlineTask = Task { [weak self] in
            do { try await deadline() } catch { return }
            guard !Task.isCancelled, let self, !self.completed else { return }
            self.resolve(nil, reason: "finalization_timeout")
            self.operationTask?.cancel()
            await cancelOperation()
        }
    }

    func take() async -> NativeVideoArtifact? {
        guard !Task.isCancelled else { cancel(); return nil }
        guard !consumed else { return nil }
        consumed = true
        if completed {
            let result = artifact; artifact = nil
            return result
        }
        let result = await withTaskCancellationHandler {
            await withCheckedContinuation { waiter = $0 }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancel() }
        }
        guard !Task.isCancelled else {
            result?.removeOwnedFile()
            return nil
        }
        return result
    }

    func cancel() {
        artifact?.removeOwnedFile()
        artifact = nil
        resolve(nil, reason: "finalization_cancelled")
        operationTask?.cancel(); deadlineTask?.cancel()
        let cancelOperation = self.cancelOperation
        Task { await cancelOperation() }
    }

    private func resolve(_ result: NativeVideoArtifact?, reason: String?) {
        guard !completed else {
            result?.removeOwnedFile()
            return
        }
        completed = true; omissionReason = reason
        deadlineTask?.cancel()
        if let waiter {
            self.waiter = nil
            waiter.resume(returning: result)
        } else { artifact = result }
    }

    deinit {
        operationTask?.cancel(); deadlineTask?.cancel()
        artifact?.removeOwnedFile()
        let cancelOperation = self.cancelOperation
        Task { await cancelOperation() }
    }
}
#endif
