// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Arms `QuickCapture.shared` behind the production `UIWindow.sendEvent` hook
// and reports each submit on screen. Everything after the hotkey match is
// stubbed: no network, no replay freeze, no toast. What stays real is the path
// under test, from the simulator's HID keyboard through UIKit's event dispatch
// into the SDK's window hook, the key mapping, the matcher and the gate.
import UIKit
@testable import EverframeKit

@MainActor
enum Harness {
    static weak var status: UILabel?
    static weak var crumbs: UILabel?
    static var submits = 0

    /// Tap breadcrumbs with no view behind them (`tap unknown`): what a
    /// nil-targeted action through the SDK's `sendAction` instrumentation
    /// records. Quick capture's focus probe must never add one.
    static func showCrumbs() {
        let count = BreadcrumbRingBuffer.shared.snapshot().filter { $0.kind == .tap && $0.message == "tap unknown" }.count
        crumbs?.text = "unknownTaps=\(count)"
        crumbs?.accessibilityValue = "unknownTaps=\(count)"
    }

    static func arm() {
        let args = ProcessInfo.processInfo.arguments
        Everframe.captureGate = true
        BreadcrumbTapNavAdapters.install()
        let qc = QuickCapture.shared
        qc.isApplicationActive = { true }
        qc.showToast = { _ in }
        // XCTest waits for the app to settle after each key, so two Shift taps
        // land seconds apart. A real double tap is well under the 0.4 s default.
        qc.doubleShiftWindow = 60
        qc.lifecycle = QuickCapture.Lifecycle(open: { UUID() }, didClose: { _ in }, cancel: { _ in })
        qc.submit = { inputs in
            submits += 1
            show("submits=\(submits) quickCapture=\(inputs.quickCapture)")
            return .submitted(reportId: UUID())
        }
        qc.beginSession(localEnabled: true, debug: true)
        if !args.contains("--remote-disabled") {
            qc.publish(remote: CaptureHotkeyConfigWire(
                enabled: true, binding: argument(after: "--binding", in: args)))
        }
        show("submits=0 armed=\(qc.isArmed)")
        showCrumbs()
        Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { _ in
            MainActor.assumeIsolated { showCrumbs() }
        }
    }

    static func show(_ text: String) {
        status?.text = text
        status?.accessibilityValue = text
    }

    private static func argument(after flag: String, in args: [String]) -> String? {
        guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
        return args[i + 1]
    }
}

/// `--resigning-field`: the field resigns first responder as soon as a key
/// press reaches it, inside UIKit's delivery of that press, as some search and
/// PIN fields do.
final class ResigningTextField: UITextField {
    var resignsOnPress = false

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        super.pressesBegan(presses, with: event)
        if resignsOnPress { resignFirstResponder() }
    }
}

final class RootViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.accessibilityIdentifier = "status"
        label.isAccessibilityElement = true
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        // A text field to focus, for the bindings that stand aside while typing.
        let field = ResigningTextField()
        field.resignsOnPress = ProcessInfo.processInfo.arguments.contains("--resigning-field")
        field.translatesAutoresizingMaskIntoConstraints = false
        field.accessibilityIdentifier = "field"
        field.borderStyle = .roundedRect
        field.autocorrectionType = .no
        view.addSubview(field)
        NSLayoutConstraint.activate([
            field.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            field.topAnchor.constraint(equalTo: label.bottomAnchor, constant: 24),
            field.widthAnchor.constraint(equalToConstant: 200),
        ])
        let crumbs = UILabel()
        crumbs.translatesAutoresizingMaskIntoConstraints = false
        crumbs.accessibilityIdentifier = "crumbs"
        crumbs.isAccessibilityElement = true
        view.addSubview(crumbs)
        NSLayoutConstraint.activate([
            crumbs.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            crumbs.topAnchor.constraint(equalTo: field.bottomAnchor, constant: 24),
        ])
        Harness.status = label
        Harness.crumbs = crumbs
        Harness.arm()
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(
        _ application: UIApplication, configurationForConnecting session: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: nil, sessionRole: session.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = RootViewController()
        window.makeKeyAndVisible()
        self.window = window
    }
}
