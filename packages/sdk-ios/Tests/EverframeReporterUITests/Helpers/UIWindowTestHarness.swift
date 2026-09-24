// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Foreground-scene + key-window harness for capture/reporter tests. Skeleton
// landed in plan 04-01; plans 04-03 and 04-06 fill the body via an
// XCUIApplication-spawned scene.
#if canImport(UIKit)
import UIKit

@MainActor
enum UIWindowTestHarness {
    static func makeKeyWindow() -> UIWindow? {
        // TODO(04-06): wire up via XCUIApplication-spawned scene
        return nil
    }
}
#endif
