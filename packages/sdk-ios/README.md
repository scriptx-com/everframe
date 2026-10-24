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
authoritatively by the dashboard. On a linked or debug-build device, shake takes
a quick capture instead (see [Quick capture](#real-iphones-and-ipads)). Disable it locally with
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

## Quick capture

Quick capture files a report with no UI: in the iOS simulator with a key
press, on a real iPhone or iPad with a shake, and on a real Apple TV by holding
Play/Pause on the Siri Remote, once the device is linked to you (or runs a
debug build). Titling and filing always happen on the dashboard, in the live
capture card.

### Simulators

While you test a build in the iOS simulator, press **⇧B** (outside a text
field) to file a report without opening the reporter. The tvOS simulator is not yet
verified. The SDK takes the
screenshot first, freezes the replay window, logs, breadcrumbs and network the
same way the reporter does, shows a short `Captured · <device name>` toast as
soon as the capture is handed to the upload, and uploads the report at once. A
report that cannot upload right now is queued and sent later, with no further
toast. Only an upload that is rejected and not queued adds
`Capture didn't upload`; a capture whose screenshot or freeze fails shows
`Capture failed` instead of `Captured`. The toast is never part of the
screenshot. Title and description stay empty; you fill them in on the
dashboard. Like the reporter, a quick capture consumes the pending
`Everframe.shared.setExtra` payload.

- **Trigger.** ⇧B by default, the same gesture as on Android emulators. The
  dashboard's per-app capture hotkey setting can pick another binding: double
  Shift, or a chord such as `Mod+Shift+B`. A binding that is also ordinary
  typing (a key alone or with Shift only, such as ⇧B) is skipped while an
  editable text input is first responder (`UITextField`, an editable
  `UITextView`, React Native and Flutter text inputs), so typing a capital B
  stays typing. Double Shift and chords with ⌘, ⌃ or ⌥ fire whatever has
  focus. The key press still reaches the app. Modifier presses reach the app
  even while the simulator window's sidebar has focus; a chord with a letter
  needs a click on the device screen first, and a click on the screen is a tap
  the app sees.
- **Debug builds.** Every simulator build counts as a debug build, Release
  configuration included, unless the app sets `EverframeConfig.debugBuild = false`.
  Real devices follow their own rules (next section).
  It also needs `reporterEnabled` and the dashboard's capture hotkey setting,
  and it does nothing while the reporter is on screen or a capture is still
  uploading. Shake-to-report is ignored while a quick capture is in flight,
  but an explicit `report.open()` during that upload still opens the reporter,
  and either report may then miss part of the frozen replay and evidence.
- **Replay.** When the dashboard's capture hotkey setting also turns on
  replay (`captureHotkey.replay`), session replay records while quick capture
  is armed, even if the app's replay setting is off. It records regardless of
  the sampling rate, because this is your own debug session; the replay
  duration and frame rate still come from the app's settings. The flag only
  ever turns replay on. When quick capture disarms, replay follows the app's
  replay setting again: at the next config refresh when the dashboard setting
  changes, and at once on `kill()` or on a `start()` with
  `quickCaptureEnabled = false`. A queued report with a native video replay
  from the same project and session keeps it when a retry in that session runs
  while quick capture still forces replay. A retry at the next app launch runs
  before the dashboard config arrives, so it sends the capture without its
  replay; the launch drain also removes it from the queued entry.
- **Opt out** locally by setting `quickCaptureEnabled` to `false` on your
  config before `start`. Local `true` never overrides a dashboard disable.

  ```swift
  var config = EverframeConfig(sdkKey: "…")
  config.quickCaptureEnabled = false
  try Everframe.shared.start(config: config)
  ```

- **Capture from your Mac.** `npx @everframe/cli capture` posts the Darwin
  notification `com.everframe.capture` to the booted simulator
  (`xcrun simctl spawn <udid> notifyutil -p com.everframe.capture`), which
  files the same capture as the hotkey. It follows the same
  gates: a simulator build (not opted out with `debugBuild = false`) with the
  dashboard's capture hotkey setting on, and nothing happens while the reporter
  is on screen or a capture is uploading. With several simulators booted, pass `--device <udid>`.
- **No screenshot, no capture.** A session started with
  `capture.screenshot = false` ignores quick capture and uploads nothing, unless
  a host plugin (Flutter's `enableQuickCapture`) supplies masked evidence; the
  trigger is dropped as `screenshot_disabled`. Kotlin Multiplatform apps start
  that way today, so they get no quick capture for now.
- **Token file.** Run `npx @everframe/cli login` once. It writes
  `~/.everframe/credentials` with your capture token (as JSON with `token`,
  `url` and `email`), and the capture is attributed to you. The SDK reads
  `$SIMULATOR_HOST_HOME/.everframe/credentials` on your Mac (normally the same
  file) fresh at every capture, sends the token only on the quick-capture
  upload, and never logs it. The token is only sent to the server it was
  issued by: when the file's `url` names a different origin than the SDK's
  ingest endpoint, the capture goes out without it. Without it, captures land
  in the app's shared inbox. A capture that is queued offline and retried later goes out without
  the token. If you cannot use the CLI, create the file yourself as
  `{"token": "<token>"}`.

### Real iPhones and iPads

On a real device, **shake** is the capture gesture. It takes the same capture
as ⇧B in the simulator (screenshot, replay window, logs, breadcrumbs and
network) when either holds:

- **The device is linked.** A linked device captures in any build, Release
  included. A capture from a device linked to you is a private draft for you,
  with the toast `Captured · <your name>`. A capture from a team device is a
  shared draft, with the toast `Captured · team device`.
- **The build is a debug build.** A development-signed build (or one started
  with `debugBuild: true`) that is not linked captures to the app's shared
  inbox, with the toast `Captured · <device name>`.

No app code is needed for either. Captures follow the same gates as in the
simulator: `quickCaptureEnabled`, `reporterEnabled` and the dashboard's quick
capture setting, no reporter on screen and one capture at a time.

- **Link a device.** On the dashboard, open Settings → Devices and click
  **Link a device**, then shake the device. It shows a banner,
  `Linking to Everframe · <number>`, with the subline
  `A teammate is linking a device. If that's not you, ignore this.` Click the
  matching number on the dashboard. The device shows `Linked to <your name>`.
  Admins can choose **Link as team device** instead; the device then shows
  `Linked as team device`. Nothing links on its own: a teammate always picks
  the number. While no one is linking, a shake on an unlinked device asks the
  server once and shows no banner.
- **Hand a device over.** A linked device keeps capturing for its owner. When
  another teammate clicks Link a device and the device is shaken, its capture
  upload shows the banner too; picking the number moves the device, and that
  capture, to the new teammate.
- **Unlinking.** Unlinking a device on the dashboard revokes its link. The
  device finds out at its next capture or config fetch. A capture sent with a
  revoked link is not stored anywhere; the device shows
  `This device was unlinked` and falls back to unlinked behavior.
- **The token.** The device token is kept in the Keychain (this device only,
  readable after first unlock), one per ingest origin and SDK key, and is sent
  only to the origin that issued it, in `X-Everframe-Capture-Token` on quick
  capture uploads and config fetches. The SDK never logs it. A linked capture
  that is queued offline is retried only while the same link is still stored;
  otherwise it is dropped, never filed into another inbox.
- **Shake-to-report.** `shakeToReportEnabled` (and the dashboard's
  shake-to-report setting) still decides only whether a shake opens the
  reporter on an unlinked release build. Shake keeps capturing on linked and
  debug devices with it off.
- **Replay.** Linked devices and debug builds record session replay while
  quick capture is armed and the dashboard's quick capture setting has replay
  on, as in the simulator.
- **End users.** Release builds on end users' devices behave exactly as
  before: shake opens the reporter when shake-to-report allows it, and replay
  is unaffected. The only visible difference is the rare linking banner if an
  end user shakes during a teammate's two-minute linking window.
- **Device linking off.** The dashboard's per-app device linking switch stops
  devices from asking to link. `quickCaptureEnabled = false` (or the
  dashboard's quick capture switch) turns off both quick capture and linking.
- **Apple TV.** See [Quick capture on Apple TV](#quick-capture-on-apple-tv).
- **Testing in a simulator.** Launch the app with `EVERFRAME_SIMULATE_DEVICE=1`
  in its environment (for example
  `SIMCTL_CHILD_EVERFRAME_SIMULATE_DEVICE=1 xcrun simctl launch <udid> <bundle-id>`)
  to make an iPhone simulator behave as a real phone: the Darwin notification
  `com.everframe.capture` (or **Device → Shake** in Simulator) then follows the
  real-device rules, including linking. The switch is ignored on real devices.

### Quick capture on Apple TV

On a real Apple TV, **hold Play/Pause** on the Siri Remote for about 1.5
seconds. It takes the same capture as a shake on a phone, under the same rules:
a linked Apple TV captures in any build, and a debug build captures to the
shared inbox. Select is never the default, because holding Select is how many
apps open a context menu. No app code is needed.

| Apple TV                                                           | Hold Play/Pause                      | Link hello              | Presses kept from the app |
| ------------------------------------------------------------------ | ------------------------------------ | ----------------------- | ------------------------- |
| Linked (any build)                                                 | Captures, `Captured · <name>`        | No                      | The gesture's own (below) |
| Unlinked, debug build                                              | Captures, `Captured · <device name>` | If device linking is on | None                      |
| Unlinked, release build                                            | Nothing visible                      | If device linking is on | None                      |
| Quick capture off (`quickCaptureEnabled = false` or the dashboard) | Nothing                              | No                      | None                      |

Linking works as on a phone: click **Link a device** on the dashboard, then
hold Play/Pause on the Apple TV. The banner `Linking to Everframe · <number>`
and the toasts use TV sizes, and they never take focus, so the remote keeps
moving focus in your app while the banner shows.

- **The gesture.** The dashboard's per-app TV gesture can replace the default
  with another long press (0.5 to 5 s), a sequence of 2 to 8 presses, or a
  chord of 2 to 4 keys. Apple TV delivers these keys: the arrows
  (`DPAD_UP`, `DPAD_DOWN`, `DPAD_LEFT`, `DPAD_RIGHT`), Select (`DPAD_CENTER`),
  Back (`BACK`, the remote's Back or Menu button), Play/Pause
  (`MEDIA_PLAY_PAUSE`), and on a connected keyboard the letters, digits and
  Shift. `MENU`, `MEDIA_FAST_FORWARD`, `MEDIA_REWIND` and the colour keys never
  reach an Apple TV app, so a gesture that uses one falls back to holding
  Play/Pause. A gesture with letters, digits or Shift stands aside while a
  text field is being edited.
- **Key handling.** The SDK reads presses as they reach the app's windows,
  before the app does.
  - A linked Apple TV keeps the gesture's presses from the app: the release of
    a fired long press, so the hold does not also toggle playback, and the
    completing press of a sequence or chord, with its release. Every other
    press, and every press on an unlinked device, reaches the app unchanged.
  - The first press of a long press always reaches the app: it is not a
    gesture until it has been held for 1.5 s. In our checks, a UIKit
    Play/Pause tap recognizer, `AVPlayerViewController` and SwiftUI's
    `onPlayPauseCommand` all act on a press's release, not its start, and
    only `onPlayPauseCommand` also acts on the release of a 1.6 s hold; so a
    hold on a linked Apple TV never toggles playback in any of them, and on an
    unlinked debug build it toggles only an `onPlayPauseCommand` handler.
  - A press the SDK keeps from the app does nothing in it: a kept arrow does
    not move focus, and a kept Select does not trigger the focused button.
  - tvOS sends one start and one release per press, with no key repeat. The
    SDK sees only the presses UIKit delivers: the Siri, TV, volume and mute
    buttons and swipes on the touch surface never reach it, so a sequence
    counts clicks only. Holding Back or Menu belongs to the system.
- **Record on device.** On the dashboard, a teammate can set the app's TV
  gesture by pressing it on a linked Apple TV. The Apple TV shows
  `Recording remote keys for 10 seconds`, records the keys pressed (at most
  32), sends them with its device token and shows `Keys sent to Everframe`.
  Nothing captures while it records, and every press still reaches the app.
  A request that arrives while the app is not on screen waits until it is, so
  the prompt is seen. A recording whose link changed or ended before the 10 s
  were up is not sent.
- **Foreground refresh.** A linked Apple TV fetches its config when the app
  returns to the foreground, at most every 10 seconds, so a Record on device
  request reaches it without a relaunch. Unlinked Apple TVs never do.
- **Testing in the tvOS simulator.** Launch the app with
  `EVERFRAME_SIMULATE_DEVICE=1` (for example
  `SIMCTL_CHILD_EVERFRAME_SIMULATE_DEVICE=1 xcrun simctl launch <udid> <bundle-id>`)
  and hold Play/Pause on the Simulator's Apple TV remote, or with
  `XCUIRemote.shared.press(.playPause, forDuration: 1.6)` in a UI test. The
  app then follows the real-device rules, including linking. Without the
  switch, a debug tvOS simulator build follows the simulator rules instead.

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
no replay. Crash and error capture, breadcrumbs, vitals and release health
work as usual.

### Companion (removed)

Everframe Companion (phone / TV pairing) has been removed. Its API remains,
deprecated, until the next major version: `Everframe.shared.companion` is
always `.unpaired` with every other value `nil`, its notifications are never
posted, `RelayWSClient.connect()` logs one warning and opens nothing, and
`CompanionCaptureBridge` and `CompanionPinPresenter.install()` do nothing. The
`companionDeviceId`, `companionBadgeEnabled` and `companionBadgePosition`
`EverframeConfig` parameters are accepted and ignored. To capture from a real
device, link it under Settings → Devices in the dashboard and use quick
capture.

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

Reporter opens now write `custom` breadcrumbs with message `reporter_opened` and data `{ source: "everframe_reporter", trigger: "button" | "shake" | "menu" | "companion" | "quick_capture" }` before evidence freezes (`companion` appears only in reports from older builds; Companion has been removed). Close/cancel writes `reporter_closed` with the same source discriminator to the live trail. Pending interaction summaries precede the opened marker. Existing `report.open()` remains valid and defaults to `button`; native shake and simulator quick captures identify their own triggers.

Native target annotations accept `reporterTrigger: "button" | "menu"`. This marks only the bound target's matching activation with top-level breadcrumb data `origin: "reporter"` and `trigger`; it never identifies an unrelated preceding tap or key. Supported RN/Expo developer-tool surfaces receive `data.origin: "devtools"` from native framework identity, without label matching. All existing capture gates, masking and registration lifetime rules apply. See the [React Native reporter-origin contract](../sdk-react-native/README.md#reporter-boundaries-and-developer-tools) for lifecycle handling, host-owned flow markers and remote-input limitations.

For host-owned flows, `report.markOpened(trigger:)` is main-actor isolated so pending UI summaries are flushed before the marker. The lower-level ring marker methods accept a completion callback for queued callers; wait for it before writing subsequent host evidence. React Native exposes this completion as an awaitable promise.
