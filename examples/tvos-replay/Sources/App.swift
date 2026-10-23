// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import UIKit
import EverframeKit

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

@MainActor final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = RailsController()
        window.makeKeyAndVisible()
        self.window = window
        let env = ProcessInfo.processInfo.environment
        guard let key = env["EVERFRAME_E2E_SDK_KEY"],
              let raw = env["EVERFRAME_DEV_INGEST_URL"], let url = URL(string: raw),
              url.host == "127.0.0.1" || url.host == "localhost" else { return }
        do {
            try Everframe.shared.start(config: EverframeConfig(sdkKey: key, environment: .development,
                release: "tvos-video-e2e", capture: CaptureConfig(logs: false, network: false, crash: env["REPLAY_TV_ERROR_AFTER"] != nil)))
            ErrorProbe.scheduleIfRequested(env: env)
        } catch { NSLog("ReplayTV Everframe SDK startup failed: %@", String(describing: error)) }
    }
}

enum ProbeFiles {
    static func url(_ name: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent(name)
    }
}
