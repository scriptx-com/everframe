// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Foundation
import EverframeKmp
import EverframeKit
import EverframeReporterUI

/// Objective-C-visible Kotlin protocol implemented by Swift, then passed to shared Kotlin logic.
/// This avoids trying to cinterop a Swift-only SDK into Kotlin/Native.
public final class EverframeSwiftDriver: NSObject, EverframeNativeDriver {
    public func start(appId: String, sdkKey: String, environment environmentName: String) -> Bool {
        let environment: EverframeConfig.Environment
        switch environmentName {
        case "development": environment = .development
        case "staging": environment = .staging
        case "production": environment = .production
        default: return false
        }
        var capture = CaptureConfig()
        capture.screenshot = false
        capture.crash = true
        capture.network = true
        capture.networkBodies = false
        do {
            // The Swift SDK currently names its key `appId`.
            try Everframe.shared.start(config: EverframeConfig(
                appId: sdkKey, environment: environment, capture: capture))
            return Everframe.shared.captureGate
        } catch {
            return false
        }
    }

    public func setUser(id: String?, email: String?, displayName: String?) {
        let user = id == nil && email == nil && displayName == nil
            ? nil : EFUser(id: id, email: email, displayName: displayName)
        Everframe.shared.setUser(user)
    }

    public func recordScreen(name: String) { Everframe.shared.recordScreen(name) }

    public func addBreadcrumb(message: String, kind: String?, level: String?) {
        Everframe.shared.addBreadcrumb(message: message, kind: kind, level: level)
    }

    public func captureHandledError(code: String) {
        Everframe.shared.captureException(KmpHandledError(code: code), options: nil, sdkName: "everframe-kmp")
    }

    public func captureException(error: KotlinThrowable) {
        Everframe.shared.captureException(error.asError(), options: nil, sdkName: "everframe-kmp")
    }

    public func openReporter(completion: @escaping (EverframeReportOutcome) -> Void) {
        Task { @MainActor in
            EFReporterPresenter.installResolver()
            do {
                let outcome = try await EFReporterPresenter.openAndAwait(sdkName: "everframe-kmp")
                switch outcome {
                case .submitted(let reportId):
                    completion(EverframeReportOutcome(status: "submitted", reportId: reportId.uuidString, reason: nil))
                case .queued(let reportId):
                    completion(EverframeReportOutcome(status: "queued", reportId: reportId.uuidString, reason: nil))
                case .cancelled:
                    completion(EverframeReportOutcome(status: "cancelled", reportId: nil, reason: nil))
                }
            } catch {
                completion(EverframeReportOutcome(status: "failed", reportId: nil, reason: String(describing: error)))
            }
        }
    }

    public func kill() { Everframe.shared.kill() }
}

private struct KmpHandledError: LocalizedError {
    let code: String
    var errorDescription: String? { "KMP handled error: \(code)" }
}
