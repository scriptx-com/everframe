// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import Flutter
import UIKit
import EverframeKit
import EverframeReporterUI

public final class EverframeFlutterPlugin: NSObject, FlutterPlugin {
    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(
            name: "dev.everframe/flutter", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(EverframeFlutterPlugin(), channel: channel)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        switch call.method {
        case "start":
            guard let environment = args["environment"] as? String,
                  environment == "development",
                  let sdkKey = args["sdkKey"] as? String,
                  !sdkKey.isEmpty else {
                result(FlutterError(code: "invalid_arguments", message: "development key required", details: nil))
                return
            }
            guard let host = IngestEndpoint.url.host,
                  host == "127.0.0.1" || host == "localhost" else {
                result(FlutterError(code: "dry_run_only", message: "loopback ingest required", details: nil))
                return
            }
            var capture = CaptureConfig()
            capture.screenshot = false
            capture.crash = false
            do {
                // The iOS native SDK currently calls its SDK key `appId`.
                try Everframe.shared.start(config: EverframeConfig(
                    appId: sdkKey, environment: .development, capture: capture))
                Task { @MainActor in
                    EFReporterPresenter.installResolver()
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
                do {
                    let outcome = try await Everframe.shared.report.open()
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
                level: args["level"] as? String)
            result(nil)
        case "kill":
            Everframe.shared.kill()
            result(nil)
        default:
            result(FlutterMethodNotImplemented)
        }
    }
}
