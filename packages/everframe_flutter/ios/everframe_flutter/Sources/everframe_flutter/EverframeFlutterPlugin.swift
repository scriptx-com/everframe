// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Flutter
import UIKit
import EverframeKit
import EverframeReporterUI

/// The masked Flutter evidence Dart sends with `openReporter` and returns for
/// `quickCaptureEvidence`. One decoder for both, so they cannot drift.
private struct FlutterMaskedEvidence {
    let maskedPng: Data
    let pixelRatio: Double?
    let replayVTree: Data?

    init?(_ args: [String: Any]?) {
        guard let maskedPng = (args?["maskedPng"] as? FlutterStandardTypedData)?.data else { return nil }
        self.maskedPng = maskedPng
        pixelRatio = (args?["pixelRatio"] as? NSNumber)?.doubleValue
        replayVTree = (args?["replayVTree"] as? FlutterStandardTypedData)?.data
    }

    /// The same checks `EFReporterPresenter.openWithMaskedPng` applies before it
    /// builds the reporter's capture from these bytes.
    var image: UIImage? {
        guard maskedPng.count >= 8, maskedPng.count <= 10_000_000,
              maskedPng.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              let image = UIImage(data: maskedPng),
              image.size.width > 0, image.size.height > 0,
              max(image.size.width, image.size.height) <= 2048 else { return nil }
        return image
    }
}

public final class EverframeFlutterPlugin: NSObject, FlutterPlugin {
    private weak var viewController: UIViewController?
    private let channel: FlutterMethodChannel
    private var activeMarkers: [UIView] = []
    /// Dart's `enableQuickCapture` registration. Survives `kill` so a later
    /// `start` reinstalls the provider, which the SDK clears on `kill`.
    private var quickCaptureHostEnabled = false

    private init(viewController: UIViewController?, channel: FlutterMethodChannel) {
        self.viewController = viewController
        self.channel = channel
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: "dev.everframe/flutter", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(
            EverframeFlutterPlugin(viewController: registrar.viewController, channel: channel),
            channel: channel)
    }

    /// The provider calls this engine's channel, so it must not outlive it. The
    /// provider is SDK-global: with several engines, any registered engine's
    /// detach clears it, and quick capture then fails closed (ignored) until an
    /// engine calls `enableQuickCapture` again.
    public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
        guard quickCaptureHostEnabled else { return }
        quickCaptureHostEnabled = false
        Everframe.shared.__setQuickCaptureEvidenceProvider(nil)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        switch call.method {
        case "start":
            guard let environmentName = args["environment"] as? String,
                  let sdkKey = args["sdkKey"] as? String,
                  !sdkKey.isEmpty else {
                result(FlutterError(code: "invalid_arguments", message: "environment and SDK key required", details: nil))
                return
            }
            let environment: EverframeConfig.Environment
            switch environmentName {
            case "development": environment = .development
            case "staging": environment = .staging
            case "production": environment = .production
            default:
                result(FlutterError(code: "invalid_arguments", message: "environment invalid", details: nil))
                return
            }
            var capture = CaptureConfig()
            capture.screenshot = false
            // Crash capture also gates explicit handled Dart errors. On unless Dart turns it off.
            capture.crash = args["crash"] as? Bool ?? true
            do {
                // The iOS SDK takes only the SDK key; the App ID is unused here.
                var config = EverframeConfig(
                    sdkKey: sdkKey, environment: environment, capture: capture,
                    releaseHealth: capture.crash && (args["releaseHealth"] as? Bool ?? true) ? ReleaseHealthConfiguration() : nil,
                    debugBuild: args["debugBuild"] as? Bool)
                config.quickCaptureEnabled = args["quickCapture"] as? Bool ?? true
                try Everframe.shared.start(config: config)
                Task { @MainActor in
                    EFReporterPresenter.installResolver()
                    // `start` keeps no provider from an earlier session's `kill`.
                    if quickCaptureHostEnabled { installQuickCaptureProvider() }
                    result(nil)
                }
            } catch {
                result(FlutterError(code: "native_failure", message: String(describing: error), details: nil))
            }
        case "openReporter":
            guard Everframe.shared.captureGate else {
                result(FlutterError(code: "not_started", message: "Everframe is not started", details: nil))
                return
            }
            Task { @MainActor in
                guard let evidence = FlutterMaskedEvidence(args) else {
                    result(FlutterError(code: "privacy_unverified", message: "Masked Flutter screenshot is unavailable", details: nil))
                    return
                }
                // The Flutter PNG is masked before encoding; view markers are
                // supplementary for native captures and may be unavailable.
                _ = installSensitiveMarkers(args, pixelRatio: evidence.pixelRatio)
                defer { clearMarkers() }
                do {
                    let outcome = try await EFReporterPresenter.openWithMaskedPng(evidence.maskedPng,
                        replayVTree: evidence.replayVTree, sdkName: "everframe-flutter")
                    switch outcome {
                    case .submitted(let reportId):
                        result(["status": "submitted", "reportId": reportId.uuidString])
                    case .queued(let reportId):
                        result(["status": "queued", "reportId": reportId.uuidString])
                    case .cancelled:
                        result(["status": "cancelled"])
                    }
                } catch {
                    result(FlutterError(code: "reporter_failed", message: String(describing: error), details: nil))
                }
            }
        case "setUser":
            let id = args["id"] as? String
            let email = args["email"] as? String
            let displayName = args["displayName"] as? String
            let user = id == nil && email == nil && displayName == nil
                ? nil : EFUser(id: id, email: email, displayName: displayName)
            Everframe.shared.setUser(user)
            result(nil)
        case "recordScreen":
            guard let name = args["name"] as? String else {
                result(FlutterError(code: "invalid_arguments", message: "name required", details: nil))
                return
            }
            Everframe.shared.recordScreen(name)
            result(nil)
        case "addBreadcrumb":
            guard let message = args["message"] as? String else {
                result(FlutterError(code: "invalid_arguments", message: "message required", details: nil))
                return
            }
            Everframe.shared.addBreadcrumb(
                message: message,
                kind: args["kind"] as? String,
                level: args["level"] as? String,
                data: args["data"] as? [String: Any])
            result(nil)
        case "captureException":
            guard let exceptionType = args["exceptionType"] as? String,
                  !exceptionType.isEmpty,
                  let message = args["message"] as? String,
                  let framesRaw = args["framesRaw"] as? [String] else {
                result(FlutterError(code: "invalid_arguments", message: "Dart error facts required", details: nil))
                return
            }
            let facts: [String: Any] = [
                "exceptionType": String(exceptionType.prefix(256)),
                "message": String(message.prefix(4096)),
                "framesRaw": framesRaw.prefix(256).map { String($0.prefix(1024)) },
                "occurredAt": ISO8601DateFormatter().string(from: Date()),
            ]
            guard let json = try? JSONSerialization.data(withJSONObject: facts),
                  let encoded = String(data: json, encoding: .utf8) else {
                result(false)
                return
            }
            result(CrashReporter.captureHandledFacts(json: encoded, sdkName: "everframe-flutter"))
        case "setQuickCaptureHost":
            guard let enabled = args["enabled"] as? Bool else {
                result(FlutterError(code: "invalid_arguments", message: "enabled required", details: nil))
                return
            }
            Task { @MainActor in
                quickCaptureHostEnabled = enabled
                if enabled {
                    installQuickCaptureProvider()
                } else {
                    Everframe.shared.__setQuickCaptureEvidenceProvider(nil)
                }
                result(nil)
            }
        case "kill":
            Task { @MainActor in
                clearMarkers()
                Everframe.shared.__setQuickCaptureEvidenceProvider(nil)
                Everframe.shared.kill()
                result(nil)
            }
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    /// Quick capture asks Dart for the masked Flutter frame instead of taking a
    /// native screenshot. A null, invalid or failed reply yields nil, which
    /// fails the capture; the SDK never falls back to an unmasked image.
    @MainActor
    private func installQuickCaptureProvider() {
        Everframe.shared.__setQuickCaptureEvidenceProvider { [weak self] in
            guard let self else { return nil }
            let reply: Any? = await withCheckedContinuation { continuation in
                self.channel.invokeMethod("quickCaptureEvidence", arguments: nil) { reply in
                    continuation.resume(returning: reply)
                }
            }
            guard let evidence = FlutterMaskedEvidence(reply as? [String: Any]),
                  let image = evidence.image else { return nil }
            return QuickCaptureHostEvidence(image: image, hostReplayVTree: evidence.replayVTree)
        }
    }

    @MainActor
    private func installSensitiveMarkers(_ args: [String: Any], pixelRatio: Double?) -> Bool {
        guard let root = viewController?.view,
              let window = root.window,
              let pixelRatio,
              pixelRatio.isFinite, pixelRatio > 0,
              abs(pixelRatio - window.screen.scale) <= 0.02,
              let rects = args["sensitiveRects"] as? [[String: Any]] else { return false }
        clearMarkers()
        for item in rects {
            guard let left = (item["left"] as? NSNumber)?.doubleValue,
                  let top = (item["top"] as? NSNumber)?.doubleValue,
                  let right = (item["right"] as? NSNumber)?.doubleValue,
                  let bottom = (item["bottom"] as? NSNumber)?.doubleValue,
                  left.isFinite, top.isFinite, right.isFinite, bottom.isFinite,
                  left >= 0, top >= 0, right > left, bottom > top,
                  right <= root.bounds.width, bottom <= root.bounds.height else {
                clearMarkers()
                return false
            }
            let marker = UIView(frame: CGRect(
                x: left, y: top, width: right - left, height: bottom - top))
            marker.backgroundColor = .clear
            marker.isUserInteractionEnabled = false
            marker.everframe_isSensitive = true
            root.addSubview(marker)
            activeMarkers.append(marker)
        }
        return true
    }

    @MainActor
    private func clearMarkers() {
        activeMarkers.forEach { $0.removeFromSuperview() }
        activeMarkers.removeAll()
    }
}
