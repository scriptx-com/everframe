<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe for iOS / iPadOS / tvOS

Native iOS Swift Package for Everframe — in-app bug reporting with annotated
screenshots, session replay, log/network ring buffers, and a built-in
SwiftUI reporter UI. Covers iPhone, iPad, and Apple TV (tvOS).

The public repository provides source and tagged binary releases. The root
SwiftPM manifest resolves the release artifacts; the source manifest used by
contributors lives beside this README.

---

See the [crash-reporting support matrix](../../docs/crash-reporting-support.md)
for exact tested paths, unsupported combinations and remaining qualification.

## Install via Swift Package Manager

In Xcode → **File → Add Package Dependencies…** add
`https://github.com/scriptx-com/everframe.git` with a version constraint
matching the SDK version you want. Then add `Everframe` and
`EverframeReporterUI` as dependencies of your app target. For the on-device
test sample apps see `examples/ios-native/` (three schemes — iPhone, iPad,
Apple TV).

```swift
// Package.swift consumer example
.package(url: "https://github.com/scriptx-com/everframe.git", from: "0.8.1"),
// Then in your target dependencies:
.product(name: "Everframe", package: "everframe"),
.product(name: "EverframeReporterUI", package: "everframe"),
```

The deployment floor is iOS 16 / iPadOS 16 / tvOS 16 / macOS 14.

---

## Initialize at startup

The same code runs in an iOS and a tvOS target. The module is `EverframeKit`
(the package product is `Everframe`), and `sdkKey` takes the app's SDK key
(`evf_live_…`). The App ID (a UUID) is only for symbol uploads; the SDK does
not take it.

```swift
import SwiftUI
import EverframeKit
import EverframeReporterUI

@main
struct MyApp: App {
    init() {
        // Wires the reporter resolver + isPresenting setter. A no-op on tvOS,
        // which has no on-device reporter. The SDK owns mobile
        // shake-to-report; buttons and key listeners stay host-owned. See
        // "Triggers are host-app concern" below.
        EFReporterPresenter.installResolver()
        do {
            try Everframe.shared.start(
                config: EverframeConfig(
                    sdkKey: "evf_live_00000000000000000000000000000000",
                    environment: .production
                )
            )
        } catch {
            // A blank or malformed key throws EverframeConfigError.missingSdkKey.
            print("Everframe did not start: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
```

With a UIKit app delegate, make the same two calls in
`application(_:didFinishLaunchingWithOptions:)`.

---

## Automatic native crashes

The source SDK connects native crash capture to `Everframe.shared.start` when
`capture.crash` is enabled (the default). It records supported Swift traps,
uncaught Objective-C exceptions and memory/signal faults in native code, then
imports them into the encrypted delivery queue on the next enabled launch.
The recorder is bundled with the SDK; hosts do not install it separately.

Capture starts asynchronously after an encrypted context is durable. There is a
capture gap during startup and user/configuration changes, including release-health
opt-in, opt-out and reconfiguration. With release health enabled, each foreground
session start adds a brief gap once the start is durable, while the context carrying
its pointer is admitted on the main thread. Entering background withdraws that
pointer before the UIKit callback returns and normally rearms a durable context
without it in the same callback; otherwise capture resumes after an asynchronous
refresh. App lifecycle changes do not pause capture otherwise. A crash already
admitted keeps its original context; later reports use the new context. Recovery
preserves the original project routing, app/device details, self-declared user,
and redaction policy, even after another user or project starts. Native reports
currently omit verified identity and continuously refreshed breadcrumbs, logs,
replay and resource samples. Symbolicated source locations require the separate
native symbol-processing pipeline; raw addresses remain available.

In React Native, a stored fatal JavaScript crash closes native capture until the
next `start`. React Native's fatal handler then aborts with `RCTFatalException`;
that abort is not reported as a second crash. If the JavaScript report could not
be stored, native capture stays on and records the abort instead.

Set `CaptureConfig(crash: false)` to disable automatic capture, or call `kill()`
to stop the running SDK. A disabled launch retains pending raw records without
promoting them. Reports already in the delivery queue follow the existing retry
policy; disabling capture does not retroactively delete queued reports.

Each enabled launch imports pending records before retiring old runs. A run
expires 14 days after its process started, or earlier under storage
pressure. The runtime keeps at most 16 runs, with bounded raw/context storage.
A process keeps at most 256 context snapshots; identical snapshots reuse their
identifier, and snapshots that neither the recorder nor a stored raw report still
references are retired, so foreground sessions do not exhaust them. Unavailable
encryption keys, unsafe storage, exhausted capacity or recorder failures leave
capture disabled. Repeated `start` calls reuse the process recorder rather than
installing competing handlers.

The installed Release qualification host is in
[`Tests/NativeCrashStartupProof`](Tests/NativeCrashStartupProof). It exercises
normal startup, real faults and relaunch delivery on an owned iOS simulator.
Physical-device lock-state and performance qualification remain separate checks.

### Foreground out-of-memory terminations (inferred)

iOS and tvOS end an app that exceeds its memory limit (jetsam) or stops responding
(watchdog) with `SIGKILL`, which no crash handler can observe. With `capture.crash`
on, the SDK records a small per-run state (app state, memory warnings and pressure,
the last memory footprint and headroom, a main-thread responsiveness ping) and, on
the next launch, reports a previous process that the OS ended in the foreground as
one fatal crash labelled as inferred:

- `Low memory kill`: a memory warning or critical memory pressure within 60 s of the
  last sample, or at most 20 % memory headroom left.
- `Unresponsive termination`: no memory evidence, and the main thread had not
  responded for at least 5 s.
- `Abnormal foreground termination`: neither.

The event has mechanism `apple-termination-inference`, no stack, the last sampled
footprint in its message, and one issue per cause, never merged with Android's
OS-confirmed low-memory issue. It is inferred only when every rule holds: no crash
report for that run, no `exit()` or `willTerminate`, no debugger ever attached,
capture armed at the time, the same app version, build and executable, the same OS
version, no reboot, the app active (or inactive with a stalled main thread) and the
run seen within the last 14 days. Only the newest previous run is evaluated, and
each is imported once.

Like Android's OS exit records, the event is anonymous: no user, session, identity,
attachments, breadcrumbs or logs. On iOS with release health it links to its frozen
session pointer as an other exit and never lowers the crash-free rate. It follows
`capture.crash`; there is no separate switch. App extensions, Mac Catalyst and iOS
apps running on a Mac are excluded, and the simulator is excluded unless
`EVERFRAME_SIMULATOR_TERMINATION_INFERENCE=1` is set for the qualification host
(the simulator reports the host Mac's boot time). Kills in background, kills before
capture is armed and `_exit()` are not reported. Sampling runs every 5 s while the
app is not in background and costs a few memory stores; the state file holds no
user data and the boot time it compares never leaves the device. Physical-device
qualification of jetsam and watchdog thresholds is pending.

---

## Foreground release-health sessions (iOS)

Release-health collection is off by default. After `start` has published the SDK
configuration, opt in with the identity of the native build actually running:

```swift
let health = try ReleaseHealthConfiguration(nativeBuildId: "ios-2026.10.08.1",
    loadedBuildId: nil, loadedBundleStatus: .notApplicable,
    userId: "opaque-account-id") // Optional; anonymous when omitted.
let ready = await Everframe.shared.setReleaseHealth(health)
```

`true` means an active foreground session start was durably appended. A `false`
result means the app is in background, SDK is not started/ready, storage is
unavailable, or this platform is unsupported. During launch the call first waits
until the SDK has observed the application state on the main thread. Opting in
while background keeps the configuration and waits for foreground; it does not
create a session.
For an embedded JavaScript bundle, pass its actual loaded build ID with
`loadedBundleStatus: .known`; use `.unknown` when its identity is unavailable.
Use `.notApplicable` for a native-only app. Do not pass a bundle
that was downloaded but has not loaded. In a React Native app, enable release
health with the React Native Provider's `releaseHealth` option instead: each
Provider configure applies its own setting, so one without `releaseHealth`, with
`enabled: false` or with a rejected identity revokes a native opt-in and erases
its queued, undelivered records.

Each SDK start requires a new opt-in. Version-3 records use `foreground-v1`:
entering foreground opens a fresh session; entering background closes it with
`outcome: completed`. UIKit inactive interruptions do not close a session.
Changing the health configuration, account or loaded bundle closes the old session
and opens a new one if foreground. Sessions in the same process share a launch
UUID but have distinct exposure UUIDs. Completion marks the end of foreground
monitoring, not healthy process termination. Death never invents a completed end.

Sessions are anonymous unless you pass `userId:`, an optional project-local
opaque account ID that is never copied from `setUser`. It must be nonblank, at
most 128 UTF-16 units and free of U+0000–U+001F control characters; otherwise
the initializer throws `ValidationError.invalidUserIdentity`. The ID is frozen for
its session. On login, logout or account switch, call `setReleaseHealth` with a
new configuration (`userId: nil` on logout); do the same when the loaded bundle
changes. Queued records keep their original subject. See
[release health observations](../../docs/release-health.md).

Collection works independently of replay, vitals and crash capture. When native
crash capture is enabled, only a pointer already durably ready can be frozen into
its immutable fatal context. Background removes that pointer synchronously;
independent background crash capture continues with no session pointer, so a crash
in background is not attributed to any session or launch. A stored React Native
JavaScript fatal closes native capture, so the abort that follows is not reported
as a second crash. When release health is enabled through the React Native
Provider, an automatic unhandled Hermes fatal captured while a session is ready
carries that session's pointer if its bundle exactly matches the session's known
loaded build, and marks the session fatal. Other JavaScript fatals (in background,
before readiness, or with a missing or different bundle identity) carry none, and
a foreground session that such a fatal ends keeps an unknown outcome. Handled
errors and promise rejections never carry a pointer. Recovery never borrows the
relaunch's session. Apple MetricKit reporting windows are not joined to these
sessions. The receiving service must support v3 before enabling this producer;
previously queued records retain their original wire version.

The encrypted app-private journal retains at most 256 records, 1 MiB total and
seven days. Capacity failure does not evict earlier records to invent coverage;
queue-loss accounting remains unavailable. Delivery retries preserve the original
route, SDK key and serialized record. Revoked or expired keys may prevent delivery.

```swift
let erasedLocally = await Everframe.shared.setReleaseHealth(nil)
```

Disabling clears readiness immediately and attempts to erase pending health
records. A failed erase keeps an in-process purge obligation that must succeed
before another opt-in becomes ready. Retry cleanup when the result is `false`;
the failed erase obligation is not guaranteed to survive process loss or restart.
Disabling prevents new native admissions from freezing the old pointer; already
admitted independent crash evidence retains its original bytes under crash
delivery/retention policy. This is not retroactive server erasure.
`kill()` revokes both capture and health. A missing end record or exit does not
mean a crash or a healthy termination. Resolved foreground-session rates describe
only sessions with a completed boundary or qualified fatal evidence; missing
outcomes remain unknown. They do not measure the full install population. tvOS
compiles this API but returns `false` for enabling collection. Automated lifecycle,
context and compilation checks do not replace physical-device qualification.

## Apple hang and exit diagnostics

On iOS 15+, explicitly opt in **after** `start`:

```swift
let enabled = await Everframe.shared.setAppleDiagnosticsEnabled(true)
// On consent withdrawal, await durable removal before treating it as complete.
let erased = await Everframe.shared.setAppleDiagnosticsEnabled(false)
```

Enabling requires a started SDK with `capture.crash` enabled. Unsupported platforms
or unmet preconditions return `false`; a storage failure also returns `false` because
the requested persistent transition did not finish. Disabling
immediately closes network admission; a failed erase remains pending and prevents
a later enable from restoring the old records. Retry disabling when storage is
available. `kill()` also closes admission and schedules erasure. A new `start`
closes the current callback window and requires another explicit enable.

The collector accepts MetricKit hang batches and aggregate app-exit counts. It
excludes MetricKit crash diagnostics, CPU/disk exceptions and signposts. Reporting
periods are never individual incident times, and aggregate counts are never crash
or fatality counts. Process, session and web exposure attribution are unavailable.
The collector is unavailable on tvOS and macOS.

Callback admission is deliberately sparse: the complete OS reporting interval
must fit within the current process's uninterrupted opt-in window, and the OS
application version/build must match the frozen native version/build. Delayed
payloads spanning restarts, updates, reconfiguration or consent changes are dropped.
This is not a comprehensive hang monitor or a crash-free denominator.

Once accepted, anonymous records use an encrypted receipt journal and outbox.
Explicit opt-in after restart permits retry only for the same SDK key and endpoint,
with the original bytes and idempotency key. At most 32 receipts / 4 MiB are retained
for seven days; no new receipt evicts an earlier one. Revocation removes Apple
receipts without taking ownership of another collector's entries. A request already
admitted to the network can complete; disabling does not claim to erase remote data.

Only bounded stack UUIDs, safe binary names, addresses and offsets are collected;
raw MetricKit JSON is not persisted. Custom redaction uses the capture-time policy.
Current qualification covers synthetic projections, durable delivery and SDK
compilation. Physical-device MetricKit callback delivery remains unqualified.

## Triggers are host-app concern

> Everframe owns mobile shake-to-report. Buttons, overlays, key listeners, and every TV trigger remain host-owned.

Shake-to-report is enabled locally by default on iPhone and iPad and controlled
authoritatively by the dashboard. Disable it locally with
`EverframeConfig(sdkKey: "…", shakeToReportEnabled: false)`. Local `true` never
overrides a dashboard disable. The SDK observes UIKit's `.motionShake` event
without Core Motion, permissions, privacy-manifest additions, or replacement
of `UIWindow.motionEnded`. tvOS and Mac Catalyst are excluded.

All other trigger detection stays in the host app. Below are the canonical
recipes the sample apps demonstrate and that real hosts can copy-paste.

Observe `report.isPresenting` (Combine `@Published` or
`Notification.Name.everframeReporterPresentingChange`) so your trigger UI can
disable itself while the reporter is up.

### (a) In-screen Button (recommended primary recipe)

```swift
struct DebugMenuView: View {
    @ObservedObject private var report = Everframe.shared.report

    var body: some View {
        Button("Open Everframe reporter") {
            Task { try? await Everframe.shared.report.open() }
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
    @ObservedObject private var report = Everframe.shared.report
    let content: () -> Content

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            content()
            Button(action: { Task { try? await Everframe.shared.report.open() } }) {
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
        Task { try? await Everframe.shared.report.open() }
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
    @ObservedObject private var report = Everframe.shared.report

    var body: some View {
        VStack(spacing: 40) {
            Text("Everframe TV sample")
            Button("Open reporter") {
                Task { try? await Everframe.shared.report.open() }
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
//                 Task { try? await Everframe.shared.report.open() }
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
@ObservedObject private var report = Everframe.shared.report
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
    forName: .everframeReporterPresentingChange,
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

Wrap SwiftUI subtrees that should be baked black in screenshots with a small
`UIViewRepresentable` backed by `EFSensitiveView`; the native sample includes
an `EFSensitiveBox` recipe:

```swift
EFSensitiveBox {
    SecureField("Password", text: $password)
}
```

For UIKit, wrap the view (or any subtree) in an `EFSensitiveView` view
or set `view.everframe_isSensitive = true` programmatically.

### Network capture (URLSession)

Install the SDK's `URLProtocol` once at startup:

```swift
URLProtocol.registerClass(EFNetworkCaptureProtocol.self)
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
            .onAppear { Everframe.shared.recordScreen("Checkout") }
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
`recordScreen` / `useEverframeScreen`, and the Android twin is `Everframe.recordScreen`
plus the `EverframeScreen()` composable.

### Opening the reporter

```swift
let result: ReportResult = try await Everframe.shared.report.open()
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

## Error cause chains

`captureException` includes `NSUnderlyingErrorKey` chains from `NSError` and
Swift errors that expose an underlying error through `CustomNSError.errorUserInfo`.
Plain Swift errors without this metadata retain their normal outer error capture.
Cause frames are empty because Foundation does not provide per-cause throw stacks.
Multiple-underlying-error branches are marked truncated and are not flattened.

Chains retain at most 8 causes, 32 frames per cause, and 65,536 serialized UTF-8
bytes after redaction. Capture owns the retained values; later mutation does not
change a queued report. Causes do not change the outer error's grouping key.

---

## Privacy

By default the SDK requests no permissions. Sensitive UI is redacted at bake
time (PRIV-03): pixels in `EFSensitiveView` / `everframe_isSensitive` /
`secureTextEntry`-style regions are baked BLACK before screenshot bytes ever
reach the reporter UI or the network.

Authentication headers (`Authorization`, `Cookie`, `X-Api-Key`, etc.) are
filtered from captured network rows.

---

## License

MIT. See top-level `LICENSE`.
