// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import SwiftUI
import EverframeKmp
import EverframeKit
import KmpComposeProbe

@main
struct KmpComposeProbeApp: App {
    var body: some Scene { WindowGroup { KmpComposeProbeHostView() } }
}

struct KmpComposeProbeHostView: View {
    @State private var client = EverframeKmp(driver: EverframeSwiftDriver())
    @State private var started = false
    @State private var status = "idle"

    var body: some View {
        VStack {
            Button("Start Everframe") {
                started = client.start(config: EverframeKmpConfig(
                    appId: ProcessInfo.processInfo.environment["EVERFRAME_APP_ID"] ?? "kmp-compose-probe",
                    sdkKey: ProcessInfo.processInfo.environment["EVERFRAME_SDK_KEY"] ?? "txx_live_" + String(repeating: "0", count: 32),
                    environment: "development"))
                status = started ? "started" : "start blocked"
            }
            ComposeControllerHost { name in
                if started { client.recordScreen(name: name) }
            }
            Button("Exercise KMP context") {
                client.captureHandledError(code: "catalog_load_failed")
                client.captureException(error: KotlinThrowable(message: "safe sample failure"))
                client.recordNetworkOperation(operation: "catalog_fetch", method: "GET", statusCode: 503, durationMs: 42)
                status = "context requested"
            }
            .disabled(!started)
            Button("Open native reporter") {
                client.openReporter { outcome in
                    DispatchQueue.main.async {
                        status = outcome.reason.map { "\(outcome.status): \($0)" } ?? outcome.status
                    }
                }
            }
            .disabled(!started)
            Text(status)
        }
    }
}

private struct ComposeControllerHost: UIViewControllerRepresentable {
    let onScreen: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIViewController(context: Context) -> UIViewController {
        let coordinator = context.coordinator
        let controller = ProbeControllerKt.makeProbeController(
            onScreen: onScreen,
            onSensitiveRect: { x, y, width, height in
                coordinator.updateSensitiveRect(CGRect(
                    x: CGFloat(x), y: CGFloat(y),
                    width: CGFloat(width), height: CGFloat(height)))
            })
        coordinator.attach(to: controller)
        return controller
    }

    func updateUIViewController(_ uiViewController: UIViewController, context: Context) {}

    final class Coordinator {
        private let marker = UIView()
        private weak var root: UIView?
        private var pendingRect: CGRect?

        func attach(to controller: UIViewController) {
            root = controller.view
            controller.view.everframe_isSensitive = true
            marker.backgroundColor = .clear
            marker.isUserInteractionEnabled = false
            marker.everframe_isSensitive = true
            controller.view.addSubview(marker)
            if let pendingRect { apply(pendingRect) }
        }

        func updateSensitiveRect(_ rect: CGRect) {
            DispatchQueue.main.async { self.apply(rect) }
        }

        private func apply(_ rect: CGRect) {
            pendingRect = rect
            guard let root,
                  rect.origin.x.isFinite, rect.origin.y.isFinite,
                  rect.width.isFinite, rect.height.isFinite,
                  rect.minX >= 0, rect.minY >= 0,
                  rect.width > 0, rect.height > 0,
                  rect.maxX <= root.bounds.width,
                  rect.maxY <= root.bounds.height else {
                root?.everframe_isSensitive = true
                return
            }
            marker.frame = rect
            root.everframe_isSensitive = false
        }
    }
}
