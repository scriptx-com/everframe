// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation

enum ReleaseHealthTransport {
    static func send(_ entry: ReleaseHealthEntry, admission: @escaping ReleaseHealthAdmission) async -> ReleaseHealthDeliveryResult {
        guard let url = URL(string: entry.endpoint) else { return .retry }
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10; config.timeoutIntervalForResource = 15
        config.httpCookieStorage = nil; config.urlCache = nil
        let session = URLSession(configuration: config, delegate: NoHealthRedirects(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        var request = URLRequest(url: url); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(entry.sdkKey)", forHTTPHeaderField: "Authorization")
        request.setValue(entry.recordID.uuidString.lowercased(), forHTTPHeaderField: "X-Everframe-Idempotency-Key")
        let pending = HealthPendingRequest()
        let status: Int = await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                let completion = HealthResponse { continuation.resume(returning: $0) }
                let task = session.uploadTask(with: request, from: entry.body) { _, response, _ in
                    completion.finish((response as? HTTPURLResponse)?.statusCode ?? 0)
                }
                if !admission({ pending.start(task) }) { completion.finish(0); task.cancel() }
            }
        } onCancel: { pending.cancel() }
        if (200..<300).contains(status) || [400, 401, 403, 404, 409, 410, 413, 422].contains(status) { return .settled }
        return .retry
    }
}
private final class HealthResponse: @unchecked Sendable {
    private let lock = NSLock(); private var callback: ((Int) -> Void)?
    init(_ callback: @escaping (Int) -> Void) { self.callback = callback }
    func finish(_ status: Int) {
        let invoke = lock.withLock { let value = callback; callback = nil; return value }
        invoke?(status)
    }
}
private final class NoHealthRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private final class HealthPendingRequest: @unchecked Sendable {
    private let lock = NSLock(); private var cancelled = false; private var task: URLSessionUploadTask?
    func start(_ task: URLSessionUploadTask) {
        lock.withLock { self.task = task; if cancelled { task.cancel() } else { task.resume() } }
    }
    func cancel() { lock.withLock { cancelled = true; task?.cancel() } }
}
