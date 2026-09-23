// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

enum UploadAuthorizationError: Error { case revoked }

/// Multipart assembly stays off main. Authorization and URLSession task start
/// share one synchronous MainActor turn, leaving no actor-hop revocation gap.
enum AuthorizedUpload {
    static func send(request: URLRequest, body: Data, session: URLSession,
                     authorize: @escaping @MainActor @Sendable () -> Bool) async throws -> (Data, URLResponse) {
        let pending = PendingUpload()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                Task { @MainActor in
                    guard !pending.isCancelled else {
                        continuation.resume(throwing: CancellationError()); return
                    }
                    guard authorize() else {
                        continuation.resume(throwing: UploadAuthorizationError.revoked); return
                    }
                    let task = session.uploadTask(with: request, from: body) { data, response, error in
                        if let error { continuation.resume(throwing: error) }
                        else if let response { continuation.resume(returning: (data ?? Data(), response)) }
                        else { continuation.resume(throwing: MultipartUploaderError.nonHTTPResponse) }
                    }
                    pending.start(task)
                }
            }
        } onCancel: { pending.cancel() }
    }
}

private final class PendingUpload: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var task: URLSessionUploadTask?
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func start(_ task: URLSessionUploadTask) {
        lock.lock(); defer { lock.unlock() }
        self.task = task
        if cancelled { task.cancel() } else { task.resume() }
    }
    func cancel() {
        lock.lock(); defer { lock.unlock() }
        cancelled = true; task?.cancel()
    }
}
