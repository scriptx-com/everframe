<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe for iOS / iPadOS / tvOS

Native iOS Swift Package for Everframe — in-app bug reporting with annotated
screenshots, session replay, log/network ring buffers, and a built-in
SwiftUI reporter UI. Covers iPhone, iPad, and Apple TV (tvOS).

Replays also attach to errors; see [session replay](../../docs/session-replay.md).

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
.package(url: "https://github.com/scriptx-com/everframe.git", from: "1.2.0"),
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
capture gap during startup and user/configuration changes, including turning release
health on or off and reconfiguring it. With release health enabled, each foreground
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
attachments, breadcrumbs or logs. With release health on, the session it ended
counts as an unknown outcome, never as a crash. It follows
`capture.crash`; there is no separate switch. App extensions, Mac Catalyst and iOS
apps running on a Mac are excluded, and the simulator is excluded unless
`EVERFRAME_SIMULATOR_TERMINATION_INFERENCE=1` is set for the qualification host
(the simulator reports the host Mac's boot time). Kills in background, kills before
capture is armed and `_exit()` are not reported. Sampling runs every 5 s while the
app is not in background and costs a few memory stores; the state file holds no
user data and the boot time it compares never leaves the device. Physical-device
qualification of jetsam and watchdog thresholds is pending.

---

## Release health (iOS and tvOS)

Release health counts crash-free foreground sessions for each version of your
app. It is on by default, and debug builds (the simulator, or a
development-signed app) aren't counted. `Everframe.shared.start` applies
`EverframeConfig.releaseHealth`; turn it off there:

```swift
try Everframe.shared.start(config: EverframeConfig(sdkKey: sdkKey, releaseHealth: nil))
```

The SDK reads the version from `CFBundleShortVersionString` (or
`CFBundleVersion` when it is missing) and the build from `CFBundleVersion`, and
crash reports carry the same version. Pass
`releaseHealth: try ReleaseHealthConfiguration(userId: accountId)` to count
crash-free users, and call `setReleaseHealth` when the account changes; that
setting lasts until the next `start`.
`ReleaseHealthConfiguration(includeDebugBuilds: true)` counts debug builds too.
Set `EverframeConfig.debugBuild` to force the answer, for example `false` for a
development-signed build that should count as a release; it also marks reports'
`context.app.debug`.
`releaseHealth: nil`, `setReleaseHealth(nil)` or `kill()` turns release health
off and erases its queued records. iOS and tvOS sessions are counted separately.
For native apps, only linked fatal evidence proves a crashed session; an inferred
termination or missing end record does not. In a React Native app, use the Provider's `releaseHealth` option instead. See
[release health](../../docs/release-health.md).

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

## Quick capture (debug simulators)

While you test a debug build in the iOS or tvOS simulator, double-tap
**Shift** to file a report without opening the reporter. The SDK takes the
screenshot first, freezes the replay window, logs, breadcrumbs and network the
same way the reporter does, uploads the report at once, and then shows a short
toast: `Captured · <device name>`, `Captured · uploads when online` when the
upload was queued, or `Capture failed`. The toast is never part of the
screenshot. Title and description stay empty; you fill them in on the
dashboard.

- **Trigger.** Double Shift by default. The dashboard's per-app capture hotkey
  setting can pick a chord such as `Mod+Shift+B` instead. Modifier presses
  reach the app even while the simulator window's sidebar has focus; a chord
  with a letter needs a click on the device screen first, and a click on the
  screen is a tap the app sees.
- **Debug simulators only.** It never runs on a device or in a release build.
  It also needs `reporterEnabled` and the dashboard's capture hotkey setting,
  and it does nothing while the reporter is on screen or a capture is still
  uploading. Shake-to-report waits for an in-flight capture to finish, but an
  explicit `report.open()` during that upload still opens the reporter, and
  either report may then miss part of the frozen replay and evidence.
- **Opt out** locally by setting `quickCaptureEnabled` to `false` on your
  config before `start`. Local `true` never overrides a dashboard disable.

  ```swift
  var config = EverframeConfig(sdkKey: "…")
  config.quickCaptureEnabled = false
  try Everframe.shared.start(config: config)
  ```

- **Token file.** When `$SIMULATOR_HOST_HOME/.everframe/credentials` on your
  Mac holds `{"token": "<token>"}` (`npx everframe login` writes it), the
  capture is attributed to you. It is read fresh at every capture, sent only
  on the quick-capture upload, and never logged. Without it, captures land in
  the app's shared inbox. A capture that is queued offline and retried later
  goes out without the token.

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
nothing to come _from_) but still seeds the next transition, and a repeated
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

### Crash-only sessions

Turn the on-device reporter off to report crashes without recording every
session, for example in production builds:

```swift
try Everframe.shared.start(config: EverframeConfig(sdkKey: "…", reporterEnabled: false))
```

Shake stays off and `report.open()` throws
`EverframeReporterError.reporterDisabled`. Network bodies are not captured.
Session replay records only in the share of sessions set by the dashboard's
crash-only coverage, none by default, so errors from the other sessions carry
no replay. Crash and error capture, breadcrumbs, vitals, release health and
companion work as usual.

A companion bond, a phone scanning the QR code or a dashboard member
attaching, upgrades the session until the next `start` or `kill`: replay and
network bodies then follow the normal dashboard settings, so a report filed
through companion has a replay from the bond on. A detach does not undo the
upgrade. Shake and `open()` stay off.

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

### Reporter interaction origins

Reporter opens now write `custom` breadcrumbs with message `reporter_opened` and data `{ source: "everframe_reporter", trigger: "button" | "shake" | "menu" | "companion" | "quick_capture" }` before evidence freezes. Close/cancel writes `reporter_closed` with the same source discriminator to the live trail. Pending interaction summaries precede the opened marker. Existing `report.open()` remains valid and defaults to `button`; native shake, companion requests and simulator quick captures identify their own triggers.

Native target annotations accept `reporterTrigger: "button" | "menu"`. This marks only the bound target's matching activation with top-level breadcrumb data `origin: "reporter"` and `trigger`; it never identifies an unrelated preceding tap or key. Supported RN/Expo developer-tool surfaces receive `data.origin: "devtools"` from native framework identity, without label matching. All existing capture gates, masking and registration lifetime rules apply. See the [React Native reporter-origin contract](../sdk-react-native/README.md#reporter-boundaries-and-developer-tools) for lifecycle handling, host-owned flow markers and remote-input limitations.

For host-owned flows, `report.markOpened(trigger:)` is main-actor isolated so pending UI summaries are flushed before the marker. The lower-level ring marker methods accept a completion callback for queued callers; wait for it before writing subsequent host evidence. React Native exposes this completion as an awaitable promise.
