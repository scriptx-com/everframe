<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @scriptx-com/traceitx-react-native

## 0.8.2

### Minor Changes

- d0b05a4: Add dashboard-controlled shake-to-report on Android and iOS phones and tablets.

  The trigger lives in the native SDKs, so bare native and React Native/Expo apps
  share the same implementation. It is enabled locally by default, requires no
  new permission, treats Android's accelerometer as optional, and excludes TV
  targets. The dashboard remains authoritative; local configuration can only opt
  out. React Native and Expo development builds should use
  `shakeToReport: { enabled: !__DEV__ }` to avoid overlapping with the development
  menu's shake gesture.

- 061f83a: Give `@traceitx/react` the host-facing API `@traceitx/react-native` already had, and fix `setExtra` corruption.
  - `recordScreen`, `useTXScreen` and `<TXScreen>` are now available on web, deriving the same `from → to` breadcrumb the native SDKs emit. Hosts previously hand-rolled this from a recipe in our own docstring, and different hosts got different subsets of the five rules right.
  - Top-level `setUser` on web; calling it with no argument clears, matching React Native.
  - `companion.start()` no longer requires `sdkKey` / `deviceLabel` when a `<TraceItXProvider>` is mounted — it defaults them from the provider config. Explicit arguments still win, and standalone `@traceitx/web` is unchanged.
  - `useCompanion()` now reports `running`, the session intent hosts previously had to track in a module-scoped flag.

  **`setExtra`, all four SDKs (web, React, React Native, and the protocol/native ceiling underneath them):** the `extra` cap is raised from 2000 characters to 16384 (16 KiB). The 2000-char figure had no storage or ingest justification — it only existed because the native SDKs happened to truncate there — and it was the tightest budget of anything in the report payload (a single breadcrumb message alone gets 2048). If you were ever hand-trimming your own `extra` object to survive the old limit, you almost certainly don't need to anymore.

  `setExtra` accepts an object as well as a string — `@traceitx/sdk-core`, `@traceitx/web` and `@traceitx/react` already had this, and `@traceitx/react-native` now does too — so hosts stop hand-serializing JSON themselves.

  **`setExtra` also accepts a resolver — `setExtra(() => buildExtra())` — and this is now the form to prefer.** It is invoked once per report, at assembly time, never at registration time, so what it returns reflects the host's state when the bug happened rather than whenever `setExtra` last ran. The string and object forms freeze a snapshot at call time, which goes stale the moment anything changes; a host that was re-calling `setExtra` on every state change to keep it fresh can replace all of those calls with one resolver registered at startup. React Native reaches the resolver through a native ask-and-wait seam, so it behaves the same there as on the web. An over-budget payload is never sliced (slicing serialized JSON produces a fragment nothing can parse); it is OMITTED from the report instead, with a warning logged at the `setExtra` call site naming the actual size and the limit. On React Native, an over-budget **string** still crosses the bridge as-is and is truncated by the native side's own raw character cut — that native behavior is unchanged; prefer the object form there.

  `EXTRA_MAX_CHARS` is now exported from `@traceitx/react` and `@traceitx/react-native` (it was already available from `@traceitx/sdk-core` and `@traceitx/web`), so a host that wants to trim its own `extra` object can check the real limit and decide for itself what to drop — that decision needs knowledge of what the host's own fields mean, which only the host has. The SDK does not attempt this on your behalf.

- 80ac7d9: **Session Vitals no longer ships CPU/memory samples.**

  Resource consumption is covered by the Report Resource Window: CPU and memory
  sampled every 2 seconds over the window before a report or crash. That is both
  finer than the vitals sample stream (which sampled every 30 seconds) and
  actually aligned to the failure it explains.

  The vitals stream cost nearly everything and explained little. Measured against
  real stored data: 79% of stored chunks came from sessions where no video ever
  played, and a single 10-hour session produced 1,154 stored objects containing
  nothing but samples and not one playback event.

  `recordSample` still exists and still runs the full entry path — session
  rotation, activity tracking and the summary accumulator — so session lifetimes
  are unchanged and `memPeak` / `memAvg` still land on the session summary. What
  stops is transport: samples no longer enter the chunk upload queue, and no
  longer enter the recent ring that gets stamped into a bug or crash report.

  Session Vitals is now playback-only: startup, buffering, bitrate and quality
  switches, errors and seeks. A session with no playback activity uploads nothing.

## 0.8.1

### Minor Changes

- bdd8ea3: **Session Vitals: React Native player tracking.**

  `@traceitx/react-native` inherits the native Session Vitals half
  automatically (background CPU/memory sampling, a session id on reports and
  crashes) with no code change, and gains a library-agnostic JS-to-native
  player bridge on top of it: `trackPlayer`/`PlayerHandle`/`useTrackPlayer`,
  `trackVitals`, and a `vitals` config passthrough (`enabled`, `sampleRate`,
  `captureSourceQuery`). Two adapters ship on top of that bridge —
  `@traceitx/react-native/integrations/react-native-video` (v7 headless
  `VideoPlayer`, `useVideoPlayerVitals`) and
  `@traceitx/react-native/integrations/theoplayer`
  (`attachTheoPlayerVitals`/`useTheoPlayerVitals`) — both pure translators;
  neither player library is imported at runtime or added as a dependency.

  Every JS event forwards through one small `RemotePlayerIntegration` +
  `RemotePlayerRegistry` pair, added to **both** native core SDKs
  (`com.traceitx.vitals` in `traceitx-core`, `TraceItXKit/Vitals` on iOS) —
  not the RN modules, which stay pure glue. This is a native SDK change, not
  only a JS one:
  - **Android (`@traceitx/sdk-android`) and iOS (`@traceitx/sdk-ios`) each
    gain two new public classes.** On Android specifically, `traceitx-core`'s
    R8 rules now keep `RemotePlayerRegistry`/`RemotePlayerIntegration`
    (`proguard-rules.pro` + `consumer-rules.pro`) — without them the published
    AAR renames these classes under minification, which is a shipped-AAR bug
    for any consumer, RN or not, that reflects on or subclasses them.
    Neither package is in this repo's changesets scope (native SDK versions
    are synced manually in lockstep with the JS release, not via changesets),
    so there is no separate changeset entry for them — this note is the
    release record.
  - **Both RN native modules now detach every live player on JS instance
    teardown.** A prior design gap left a full JS reload (Fast Refresh
    notwithstanding — this is a full instance reload) with stale player
    registrations attached and their spans still open in the native
    registry. `detachAll()` on each core registry now closes every handle
    (emitting `player_detach`) and clears the map, called from the RN
    module's own instance-teardown hook (`RCTInvalidating`/`invalidate()` on
    iOS, `NativeModule.invalidate()` on Android) — never from `configure()`,
    since child effects that register players run before the Provider's
    configure-on-mount and clearing there would drop legitimate
    registrations made during that same mount.
  - **`configure()` is idempotent.** A repeat `configure()` with the same
    config, against an already-started SDK, no longer calls
    `TraceItX.start(...)` — a start supersedes the running SDK and detaches
    every player integration it announced, which is a wildly expensive answer
    to a Provider that merely remounted with an unchanged config. Both native
    sides decide this against the _installed_ config, not against a cache of
    the options they were last handed. Known limitation: when the config DID
    change the SDK does restart, and players tracked before that restart stay
    untracked until their screens remount. Two React instances in one process
    are likewise uncoordinated — if a second one restarts the SDK, the first's
    players stay untracked until its own screens remount.

  Known gaps, not fixed here: `rate_change` was not observed from
  react-native-video v7 on Android in our Android emulator smoke — the library
  does forward ExoPlayer's `onPlaybackParametersChanged`, so this is a
  "not seen in our smoke run" result rather than a proven library gap;
  react-native-video v7 has no tvOS support at all (no podspec/target) — use
  THEOplayer or a custom adapter on Apple TV; a native react-native-video
  plugin attaching the real ExoPlayer/AVPlayer instance is a follow-up.

  **react-native-video adapter defaults.** `useVideoPlayerVitals` does NOT
  subscribe to `onError` unless you pass `captureErrors: true` — registering
  any `onError` listener makes react-native-video stop throwing synchronously
  from `play()`/`seek*()` for the whole app, so the adapter stays observationally
  neutral by default and reports fatal errors from `onStatusChange('error')`
  (no error code). `onBandwidthUpdate` is mapped per platform: rendition
  bitrate on iOS, bandwidth estimate on Android. An out-of-range
  `vitals.sampleRate` is ignored (server rate applies) instead of failing the
  SDK start.

## 0.7.0

### Minor Changes

- b3f851e: **Android: UI-tree capture is now opt-in, and tap targets resolve on device.**

  `CaptureConfig.uiTree` defaults to `false`. Until now the flag existed but
  nothing in the SDK read it — every reporter open walked the host activity's
  whole view hierarchy (including the Compose semantics tree) and shipped the
  result in the envelope, where it routinely dominated payload size to back a
  single admin view.

  Tap-to-identify does not need the tree on the wire any more.
  `payload.reportTarget[]` now carries the tapped node inline — `node`
  (children-stripped), `ancestors` (`{name, type}` from the root down to but not
  including the match) and `rootRect` — resolved on device by
  `FindPathAt.resolveEntry(tree, path, treeKind)`, which mirrors
  `resolveReportTargetEntry` in `@traceitx/protocol` and the iOS
  `FindPathAt.resolveEntry`, and is held to the same shared parity fixture. The
  walk itself is deferred to the first Select-tool tap and memoised for the
  reporter's lifetime, so a report with no tap never walks at all.

  **Host action 1 — the envelope no longer carries the tree by default.** If you
  rely on `payload.uiTree` reaching the envelope, pass
  `CaptureConfig(uiTree = true)` explicitly. Otherwise nothing changes: the
  resolved node ships either way.

  **Host action 2 — none. There is no source-breaking change.** The reporter
  composables that changed shape to take a tree _provider_ instead of a tree
  (`ReporterRoot`, `FocusedAnnotation`, `AnnotationCanvas`) are all `internal`,
  so no host can call them.

  The only public-surface change is additive: `UITreeCapture.captureForActivity`
  gains an optional `exclude: View?`, defaulting to `null`, which existing calls
  never have to pass. It exists because the lazy walk now runs while the reporter
  is on screen, and the reporter's own `ComposeView` is attached to
  `android.R.id.content` — the very view the walk roots at. Excluding it (rather
  than rooting the walk elsewhere) keeps the root node and every child index
  identical to a pre-reporter walk, so the lazy and eager paths produce the same
  paths.

  A failed walk now clears the tap highlight instead of leaving the previous
  tap's selection on screen, so a capture failure can no longer be mistaken for
  having picked the wrong element. The same fix landed on iOS and web.

- 4f4e48d: **iOS: UI-tree capture is now opt-in, and tap targets resolve on device.**

  `CaptureConfig.uiTree` defaults to `false`. Until now the flag existed but
  nothing in the SDK read it — every reporter open walked the host's entire view
  hierarchy and shipped the whole tree in the envelope, where it routinely
  dominated payload size to back a single admin view.

  Tap-to-identify does not need the tree on the wire any more. `payload.reportTarget[]`
  now carries the tapped node inline — `node` (children-stripped), `ancestors`
  (`{name, type}` from the root down to but not including the match) and
  `rootRect` — resolved on device by `FindPathAt.resolveEntry(tree:path:treeKind:)`,
  which mirrors `resolveReportTargetEntry` in `@traceitx/protocol` and is held to
  the same shared parity fixture. The walk itself is deferred to the first
  Select-tool tap and memoised for the presentation, so a report with no tap never
  walks at all.

  **Host action 1 — the envelope no longer carries the tree by default.** If you
  rely on `payload.uiTree` reaching the envelope, pass `CaptureConfig(uiTree: true)`
  explicitly. Otherwise nothing changes: the resolved node ships either way, and a
  missing tree is no longer reported as
  `captureControl.degradedReason = "ui_tree_unavailable"` unless capture was
  actually requested and failed.

  **Host action 2 — `FocusedAnnotationViewController.init` is source-breaking.**
  Deferring the walk means the editor can no longer be handed an
  already-captured tree, so its `uiTree:` parameter is replaced by
  `uiTreeProvider:`, which takes a closure that produces the tree on demand:

  ```swift
  // before
  FocusedAnnotationViewController(sourceImage: image, uiTree: tree, …)

  // after — pass a closure returning the tree instead of the tree itself
  FocusedAnnotationViewController(sourceImage: image, uiTreeProvider: { tree }, …)
  ```

  The closure is `(@MainActor () -> UITree?)?`. It is called at most once per
  presentation, on the first Select-tool tap; returning `nil` means the walk
  failed and the tap is a no-op, and passing `nil` for the whole parameter hides
  the Select tool. Wrapping an existing tree in `{ tree }` reproduces the old
  behaviour exactly. This affects only hosts that construct the fullscreen
  annotation editor directly — hosts going through
  `TraceItX.shared.report.open()` need no change.

## 0.6.6

### Minor Changes

- 8159f83: Companion attach now requires device consent: attaching from the dashboard
  shows a 4-digit code on the device (rendered by the SDK by default;
  `attachPinUi: 'custom' | 'off'` to override) that the dashboard member must
  type. Devices on older SDK versions keep one-click attach.

### Patch Changes

- 19d6d10: Replay image capture: the asset byte budget is now scoped to the replay
  window rather than the whole session.

  `spentBytes` only ever grew and was reset only at a report boundary, while
  the buffer it feeds keeps a rolling last-N-seconds window. On an image-dense
  app the budget was exhausted by images belonging to frames long since pruned;
  capture then stopped entirely and every on-screen image degraded to a
  placeholder within about half a second, for the rest of the session.

  Assets now carry a last-seen timestamp keyed on their content hash, are swept
  at the start of each walk against a horizon of twice the replay window, and
  are evicted oldest-first under pressure. Defaults are unchanged.

## 0.6.4

## 0.6.3

### Patch Changes

- 16e10a6: Fixed: upgrading `@traceitx/react-native` did not upgrade the native SDK underneath it.

  The bridge derived its native dependency ranges from its own version as `~> X.Y.0` (CocoaPods) and `X.Y.+` (Gradle) — a ceiling with no floor. Both are satisfied by `X.Y.0` forever, so a project that had already resolved the native SDK once kept it:
  - **iOS.** CocoaPods only re-resolves a pod whose `Podfile.lock` entry no longer fits its constraint. `pod install` therefore kept returning the previously locked `TraceItX`, however far ahead the npm package moved. Nothing in the project surfaced the mismatch — every manifest read the new version and only the lockfile disagreed — so an app could sit on an older native SDK indefinitely, missing native fixes it appeared to have. Recovering needed an explicit `pod update TraceItX` (or deleting a generated `ios/` directory), which is not something a correctness property should depend on anyone remembering.
  - **Android.** Gradle resolves `X.Y.+` to the highest version it can currently see, so a stale dynamic-version cache — or a `mavenLocal` holding an older patch — could hand the bridge an AAR older than the JS half it shipped with. Gradle re-resolves upward once the cache expires, which narrowed the window rather than closing it.

  Both ranges now floor at the package's exact version: `~> X.Y.Z` and `[X.Y.Z, X.(Y+1).0)`. They still exclude every other minor, and a stale entry is now unsatisfiable, so an ordinary `pod install` or Gradle build picks up the matching native version with no second command and no cache expiry to wait on.

  **If you are upgrading from an affected version**, your existing lockfile may still pin the old native SDK until this release lands. On iOS, run `pod update TraceItX` once (or regenerate `ios/`); from this release onward `pod install` is enough.

  Every release publishes the native SDKs before the npm packages and verifies the exact version is fetchable from Maven Central and CocoaPods trunk first, so the tighter range always has something to resolve against. The `TRACEITX_NATIVE_POD_VERSION` and `traceitxNativeVersion` overrides are unchanged.

## 0.6.1

## 0.6.0

### Minor Changes

- d08a35f: Companion native device legs (tvOS/iOS, Android TV, and the React Native facade over both). A TV can now announce itself to the dashboard, render the short display code beside its QR, surface the name of the team member who attached, and carry that member's attribution through to ingest so the report is credited to them. Nothing here changes the QR/report path: a device that cannot announce — offline, revoked key, older server, timeout — falls through to the plain relay socket and behaves exactly as it did before, simply absent from the dashboard list.

  **This release is binary-breaking for prebuilt native consumers and versions all four SDKs to 0.5.0 in lockstep.** On iOS, `MultipartUploader.upload` and `ReportSubmitter.submit` gained a `companionAttribution:` parameter and `ReporterSubmission.Inputs` gained a public stored property; the XCFramework is built with `-enable-library-evolution`, so the old mangled symbols are gone and source compatibility does not imply binary compatibility — precompiled consumers must recompile, and the SDK and XCFramework must version together. On Android, `RelayWSClient.CLOSE_SERVER_SHUTDOWN` kept its name but changed value from `4006` to `4005` as part of realigning the close-code table to the relay's catalog; because it is a public `const val` it is inlined into consumer bytecode, so a consumer compiled against an earlier AAR still tests for `4006`. See CHANGELOG.md for the full close-code table and the recompile guidance.

  The JS SDK's only change is a defensive one: `companion.announce()` now treats a present-but-blank `ticket` or `code` as a failed announce and falls back to the ticketless path, matching the native ports.

- 4058cf9: Renamed to the `@traceitx` scope and published to npmjs.org.

  `@scriptx-com/traceitx-react` is now `@traceitx/react`, and
  `@scriptx-com/traceitx-react-native` is now `@traceitx/react-native`. Both now
  publish publicly to npmjs.org instead of to GitHub Packages under a restricted
  grant, so `npm install` works with no `.npmrc` entry, no personal access token,
  and no access grant — matching the Android (Maven Central) and iOS (CocoaPods)
  SDKs. Update your import paths and remove any `@scriptx-com` registry mapping
  from your `.npmrc`.

  The scope now matches the product rather than the publishing entity, and the
  native coordinates it already used (`com.traceitx:core`, `pod TraceItX`). No
  API changed, and the report envelope is unaffected — `sdk.name` remains
  `traceitx-react`, so servers and dashboards keyed on it need no change.

- 7cb6d68: Automatic crash/error reporting, on by default. Uncaught errors now become unattended reports without any user interaction: on web, `window.onerror` and `unhandledrejection` are captured (exception type, message, redacted stack frames, breadcrumb trail snapshot), enqueued to the outbox, and drained immediately; on React Native, a default-on global ErrorUtils handler forwards the same facts synchronously to the native SDK (Android/iOS), which persists them crash-safely and delivers on next launch (fatal) or immediately (non-fatal). Fatal vs. non-fatal is expressed by the envelope's new `source` field (`"crash"` / `"error"`); error storms are throttled per fingerprint and per session (on React Native, fatal errors always report — only non-fatal ones count against the throttle).

  Everything in the report is data the SDK already captures, fully redacted — no screenshots, UI trees, logs, or network entries are attached to unattended reports. To opt out entirely, set `crashReporting: { disabled: true }` in the provider config (client veto only — it can turn capture off, never force anything on; the SDK-wide `disabled` flag also suppresses it).

## 0.4.2

### Patch Changes

- Lower the iOS/tvOS deployment target in `TraceItXRN.podspec` from 16.0 to 15.0 to match the native TraceItX iOS SDK (`TraceItX.podspec` / `Package.swift`, both iOS 15 / tvOS 15). The RN bridge wraps the native SDK, so its minimum must not exceed what it wraps — 16.0 needlessly excluded iOS/tvOS 15 host apps the native code already supports.

## 0.4.0

### Minor Changes

- 4299929: Remove the host-settable `sdkVersion` from the `TraceItXProvider` config. The SDK version is owned by the SDK and stamped per release on the native side (`TraceItX.SDK_VERSION`), never by the host. The field was already non-functional (the host-passed value landed in `TraceItXConfig.release` and never reached the report envelope), so dropping it is behavior-neutral — reports continue to carry the native SDK's own version.

## 0.3.1

### Patch Changes

- 68807ba: BREAKING: `apiKey` is now required on the host-facing `RuntimeConfig` (the `TraceItXProvider config` prop), matching the React SDK. A missing key is now a compile-time error instead of a runtime `Bearer undefined` / 401. The native bridge `ConfigOpts.apiKey` stays optional, so the generated TurboModule spec is unchanged.
