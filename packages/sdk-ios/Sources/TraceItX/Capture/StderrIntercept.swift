// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// dup2-based stderr intercept. Per RESEARCH Finding 5 — OSLogStore is
// sim-only/entitled on App Store builds, so we capture stderr/stdout writes
// via a Pipe and forward to the original FD so Console.app debugging keeps
// working.
//
// Lifecycle:
//   install()   — saves dup(STDERR_FILENO) → originalStderr;
//                 dup2(pipe.write → STDERR_FILENO);
//                 readabilityHandler appends to LogRingBuffer.shared
//                 AND writes the same bytes back to originalStderr.
//   uninstall() — clears handler; dup2(originalStderr → STDERR_FILENO); close();
//                 resets state. Idempotent.
//
// Idempotency: a second install() while installed is a no-op (logged via
// `installedForTesting` for unit verification).
//
// Threat T-04-18 disposition (accept): if the process is force-killed mid-write
// the next launch resets stderr to default — kernel cleans up FDs.
import Foundation

enum StderrIntercept {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var installed = false
    nonisolated(unsafe) private static var originalStderr: Int32 = -1
    nonisolated(unsafe) private static var pipe: Pipe?

    /// Test-only flag — exposed for LogRingBufferTests.logCaptureInstallIsIdempotent.
    static var installedForTesting: Bool {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    static func install() {
        lock.lock(); defer { lock.unlock() }
        guard !installed else { return }  // idempotent
        let p = Pipe()
        let saved = dup(STDERR_FILENO)
        guard saved >= 0 else { return }  // dup() failed — abort install
        originalStderr = saved
        dup2(p.fileHandleForWriting.fileDescriptor, STDERR_FILENO)
        p.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            // Forward bytes to original stderr so Console.app sees them.
            let originalFD = StderrIntercept.originalStderr
            if originalFD >= 0 {
                _ = data.withUnsafeBytes { buf -> Int in
                    guard let base = buf.baseAddress else { return 0 }
                    return write(originalFD, base, data.count)
                }
            }
            // Apply redaction at append time (PRIV-03), then enqueue.
            guard let s = String(data: data, encoding: .utf8) else { return }
            let redacted = RedactionEngine().redact(s)
            LogRingBuffer.shared.append(LogEntry(timestamp: Date(), level: "default", message: redacted))
            // Task 7: breadcrumb dual-write. `redacted` is already
            // redaction-passed — do not redact twice.
            ConsoleBreadcrumbAdapter.dualWrite(rawLevel: "default", redactedMessage: redacted)
        }
        pipe = p
        installed = true
    }

    static func uninstall() {
        lock.lock(); defer { lock.unlock() }
        guard installed else { return }  // idempotent
        pipe?.fileHandleForReading.readabilityHandler = nil
        if originalStderr >= 0 {
            dup2(originalStderr, STDERR_FILENO)
            close(originalStderr)
            originalStderr = -1
        }
        pipe = nil
        installed = false
    }
}
