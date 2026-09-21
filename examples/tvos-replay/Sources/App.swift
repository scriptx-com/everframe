// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import UIKit
import Combine
import TraceItXKit

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

@MainActor final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var relay: RelayWSClient?
    private var bridge: CompanionCaptureBridge?
    private var subscriptions = Set<AnyCancellable>()

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = RailsController()
        window.makeKeyAndVisible()
        self.window = window
        let env = ProcessInfo.processInfo.environment
        guard let key = env["TRACEITX_E2E_SDK_KEY"],
              let raw = env["TRACEITX_DEV_INGEST_URL"], let url = URL(string: raw),
              url.host == "127.0.0.1" || url.host == "localhost" else { return }
        do {
            try TraceItX.shared.start(config: TraceItXConfig(appId: key, environment: .development,
                release: "tvos-video-e2e", capture: CaptureConfig(logs: false, network: false, crash: false),
                companionBadgeEnabled: false))
            let client = RelayWSClient(endpoint: url, companion: TraceItX.shared.companion,
                sdkKey: key, deviceLabel: "tvOS Replay Validation")
            relay = client
            bridge = CompanionCaptureBridge(client: client)
            TraceItX.shared.companion.$pairUrl.sink { url in
                guard let url else { return }
                // Runtime-only token handoff to the local browser driver. Never log/commit it.
                try? Data(url.utf8).write(to: ProbeFiles.url("pair-url.txt"), options: .atomic)
            }.store(in: &subscriptions)
            client.connect()
        } catch { NSLog("ReplayTV SDK startup failed: %@", String(describing: error)) }
    }
}

enum ProbeFiles {
    static func url(_ name: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }
}
