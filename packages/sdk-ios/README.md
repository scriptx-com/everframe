<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# TraceItX for iOS / iPadOS / tvOS

Native iOS Swift Package for TraceItX — in-app bug reporting with annotated
screenshots, session replay, log/network ring buffers, and a built-in
SwiftUI reporter UI. Covers iPhone, iPad, and Apple TV (tvOS).

The public repository provides source and tagged binary releases. The root
SwiftPM manifest resolves the release artifacts; the source manifest used by
contributors lives beside this README.

---

## Install via Swift Package Manager

In Xcode → **File → Add Package Dependencies…** add
`https://github.com/scriptx-com/traceitx-releases.git` with a version constraint
matching the SDK version you want. Then add `TraceItX` and
`TraceItXReporterUI` as dependencies of your app target. For the on-device
test sample apps see `examples/ios-native/` (three schemes — iPhone, iPad,
Apple TV).

```swift
// Package.swift consumer example
.package(url: "https://github.com/scriptx-com/traceitx-releases.git", from: "0.8.1"),
// Then in your target dependencies:
.product(name: "TraceItX", package: "traceitx-releases"),
.product(name: "TraceItXReporterUI", package: "traceitx-releases"),
```

The deployment floor is iOS 16 / iPadOS 16 / tvOS 16 / macOS 14.

---

## Initialize at startup

```swift
import TraceItX
import TraceItXReporterUI

@main
struct MyApp: App {
    init() {
        try? TraceItX.shared.start(
            config: TraceItXConfig(
                appId: "txx_live_00000000000000000000000000000000",
                endpoint: URL(string: "https://ingest.your-tenant.example/api/ingest")!,
                sdkKey: "txx_live_…",
                environment: .production
            )
        )
        // Wires the reporter resolver + isPresenting setter.
        // The SDK owns mobile shake-to-report; buttons and key listeners stay
        // host-owned. See "Triggers are host-app concern" below.
        TXReporterPresenter.installResolver()
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

---

## Triggers are host-app concern

> TraceItX owns mobile shake-to-report. Buttons, overlays, key listeners, and every TV trigger remain host-owned.

Shake-to-report is enabled locally by default on iPhone and iPad and controlled
authoritatively by the dashboard. Disable it locally with
`TraceItXConfig(appId: "…", shakeToReportEnabled: false)`. Local `true` never
overrides a dashboard disable. The SDK observes UIKit's `.motionShake` event
without Core Motion, permissions, privacy-manifest additions, or replacement
of `UIWindow.motionEnded`. tvOS and Mac Catalyst are excluded.

All other trigger detection stays in the host app. Below are the canonical
recipes the sample apps demonstrate and that real hosts can copy-paste.

Observe `report.isPresenting` (Combine `@Published` or
`Notification.Name.traceItXReporterPresentingChange`) so your trigger UI can
disable itself while the reporter is up.

### (a) In-screen Button (recommended primary recipe)

```swift
struct DebugMenuView: View {
    @ObservedObject private var report = TraceItX.shared.report

    var body: some View {
        Button("Open TraceItX reporter") {
            Task { try? await TraceItX.shared.report.open() }
        }
        .disabled(report.isPresenting)
    }
}
```

Pointer to sample: `examples/ios-native/SampleApp/ContentView.swift`.

### (b) In-app overlay (SwiftUI ZStack)

For hosts that want a floating affordance without a separate `UIWindow`.

```swift
struct AppRoot<Content: View>: View {
    @ObservedObject private var report = TraceItX.shared.report
    let content: () -> Content

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            content()
            Button(action: { Task { try? await TraceItX.shared.report.open() } }) {
                Image(systemName: "ant.circle.fill")
                    .font(.system(size: 44))
                    .padding(20)
            }
            .disabled(report.isPresenting)
        }
    }
}
```

### (c) `UIWindow` overlay (full-fidelity floating bubble)

The previous Phase-4 SDK bubble was implemented this way; here is the recipe
hosts can keep using directly. The bubble lives in a separate `UIWindow` at
`windowLevel = .normal + 1` and **MUST** override `hitTest(_:with:)` so the
bubble window does NOT swallow every touch — without this trick, the bubble
window steals every tap, scroll, and gesture in the host app. This is a real
footgun; the recipe spells it out explicitly.

```swift
final class BubblePassthroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        // Only the bubble subview consumes touches — everything else falls
        // through to the host's normal windows. WITHOUT this, the bubble
        // window swallows EVERY touch in the host app.
        guard let hit = super.hitTest(point, with: event),
              hit !== rootViewController?.view else { return nil }
        return hit
    }
}

@MainActor
final class HostBubble {
    private var window: BubblePassthroughWindow?

    func install(in scene: UIWindowScene) {
        let w = BubblePassthroughWindow(windowScene: scene)
        w.windowLevel = .normal + 1
        let root = UIViewController()
        root.view.backgroundColor = .clear
        let bubble = UIView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        bubble.layer.cornerRadius = 22
        bubble.backgroundColor = .systemRed
        bubble.center = CGPoint(x: scene.coordinateSpace.bounds.width - 40,
                                 y: scene.coordinateSpace.bounds.height - 80)
        bubble.addGestureRecognizer(UITapGestureRecognizer(
            target: self, action: #selector(tapped)))
        root.view.addSubview(bubble)
        w.rootViewController = root
        w.isHidden = false
        window = w
    }

    @objc private func tapped() {
        Task { try? await TraceItX.shared.report.open() }
    }
}
```

### (d) Apple TV remote combo (recommended primary + commented fallback)

The recommended primary recipe on tvOS is a focused on-screen `Button` (the
SwiftUI focus engine routes Siri Remote Select to it automatically — no
press override needed). For hosts that want a key-combo recipe, the sample
ships `examples/ios-native/SampleAppTV/PressForwarder.swift` (~95 LOC,
sample-owned, NOT promoted to the SDK) — a `UIViewControllerRepresentable`
wrapping a `UIHostingController` that overrides `pressesBegan(_:with:)` and
runs a sample-owned debouncer.

```swift
struct DebugMenuView: View {
    @ObservedObject private var report = TraceItX.shared.report

    var body: some View {
        VStack(spacing: 40) {
            Text("TraceItX TV sample")
            Button("Open reporter") {
                Task { try? await TraceItX.shared.report.open() }
            }
            .disabled(report.isPresenting)
        }
    }
}
```

Commented-out alternate (`playPause × 3 within 1500ms`):

```swift
// final class HostViewController: UIViewController {
//     private var combo: [TimeInterval] = []
//     override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
//         for press in presses where press.type == .playPause {
//             let now = ProcessInfo.processInfo.systemUptime
//             combo.append(now); if combo.count > 3 { combo.removeFirst() }
//             if combo.count == 3, (combo.last! - combo.first!) <= 1.5 {
//                 combo.removeAll()
//                 Task { try? await TraceItX.shared.report.open() }
//                 return  // consume the third playPause
//             }
//         }
//         super.pressesBegan(presses, with: event)
//     }
// }
```

**Reserved tvOS press types — never use as triggers**: `.menu` is
system-reserved (long-press exits app, short-press navigates back); `.select`
drives the focus engine and overriding it makes every focused button feel
broken. The SDK no longer validates this; the host is responsible.

### Anti-recommendations (NONE shipped, NONE recommended)

- A custom `UIWindow` that does NOT implement the
  `BubblePassthroughWindow.hitTest` trick — would swallow every touch on
  screen. Anti-pattern; do not ship.
- The macOS / Mac Catalyst `SYSTEM_ALERT_WINDOW`-style "always on top" panel pattern is an anti-pattern — never use it as a debug trigger on iOS / tvOS.
- Custom `motionEnded(_:with:)` shake handlers are unnecessary and can compete
  with framework handlers. Configure the built-in trigger instead.

### Observing `report.isPresenting`

Combine / SwiftUI:

```swift
@ObservedObject private var report = TraceItX.shared.report
// then …
.disabled(report.isPresenting)
// or subscribe directly:
report.$isPresenting.sink { isPresenting in
    myUIButton.isEnabled = !isPresenting
}.store(in: &cancellables)
```

NotificationCenter (UIKit-only / non-Combine consumers):

```swift
NotificationCenter.default.addObserver(
    forName: .traceItXReporterPresentingChange,
    object: nil,
    queue: .main
) { note in
    let presenting = note.userInfo?["isPresenting"] as? Bool ?? false
    myUIButton.isEnabled = !presenting
}
```

The Notification fires on every flip (true on present-begin; false on
dismiss). userInfo key is the literal string `"isPresenting"` carrying a
`Bool`. Identical-value writes are de-duplicated — you will not receive
duplicate-true posts.

For the cross-SDK contract statement see the top-level
[README.md](../../README.md#triggers-are-a-host-app-concern).

---

## Public API

### Marking sensitive UI

Use `View.txSensitive()` on SwiftUI subtrees that should be baked black in
screenshots:

```swift
SecureField("Password", text: $password)
    .txSensitive()
```

For UIKit, wrap the view (or any subtree) in a `TXSensitiveContainer` view
or set `view.tx_sensitive = true` programmatically.

### Network capture (URLSession)

Install the SDK's `URLProtocol` once at startup:

```swift
URLProtocol.registerClass(TXNetworkCaptureProtocol.self)
```

Captured method, URL, status, latency, and a redacted view of headers go
into a 250-entry ring buffer (configurable via
`CaptureConfig.ringBufferCapacity`).

### Navigation breadcrumbs

UIKit navigation is captured automatically: the SDK observes
`UIViewController.viewDidAppear` and emits a `.navigation` crumb whenever the
appearing controller is pushed onto a `UINavigationController` or presented
modally, naming the screen after the controller's class. Container churn and
tab re-selections are deliberately excluded to keep the trail readable, so
**tab switches emit nothing** — mark those explicitly if they matter.

**SwiftUI navigation is not automatic.** A `NavigationStack` / `NavigationLink`
push is not backed by discrete view controllers, so there is nothing to
observe. Mark screens from `.onAppear`:

```swift
struct CheckoutView: View {
    var body: some View {
        Form { ... }
            .onAppear { TraceItX.shared.recordScreen("Checkout") }
    }
}
```

`recordScreen` feeds the SAME global `from → to` chain as the UIKit
auto-capture, so a mixed app reads as one coherent trail
(`RootViewController → Checkout → ConfirmationViewController`) rather than two
interleaved ones. The chain is global and chronological — a tab switch
correctly reads `TabA → TabB` — the first screen emits nothing (there is
nothing to come *from*) but still seeds the next transition, and a repeated
screen is suppressed rather than logged. Blank names are dropped, and the call
is a no-op before `start()` or while the `navigation` kind is disabled, so it
is safe to call unconditionally.

Names should be route identifiers, never user content — they travel in the
report and are shown verbatim in triage.

For a non-Swift host: React Native bridges to this same entry point via
`recordScreen` / `useTXScreen`, and the Android twin is `TraceItX.recordScreen`
plus the `TXScreen()` composable.

### Opening the reporter

```swift
let result: ReportResult = try await TraceItX.shared.report.open()
```

`ReportResult` is one of `.submitted`, `.queued`, `.cancelled(reason)`. The
SDK never throws from inside `start()` — only from `open()` when the host
explicitly awaits the result.

---

## R8 / minification

n/a on iOS — Swift name preservation is the default. Component-path
reflection on iOS uses `String(reflecting:)` against the SwiftUI view tree
without any build-time munging. No keep rules or extra Xcode build settings
required.

---

## Privacy

By default the SDK requests no permissions. Sensitive UI is redacted at bake
time (PRIV-03): pixels in `View.txSensitive()` / `TXSensitiveContainer` /
`secureTextEntry`-style regions are baked BLACK before screenshot bytes ever
reach the reporter UI or the network.

Authentication headers (`Authorization`, `Cookie`, `X-Api-Key`, etc.) are
filtered from captured network rows.

---

## License

MIT. See top-level `LICENSE`.
