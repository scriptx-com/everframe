<!-- SPDX-License-Identifier: MIT -->

## 1.2.1

### Minor Changes

- ceb86ab: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  New `reporter: { disabled: true }` config option for crash-only sessions. Such a session reports crashes and errors but has no on-device way to file a report: no hotkey, no "New report" button in the inbox, and `open()` rejects with the new `EverframeReporterDisabledError`. Session replay samples against the app's crash-only rate, which is 0 unless the dashboard raises it, and network bodies are not captured. A companion bond upgrades the session to the normal replay and network-body settings for the rest of the session, and recording starts at the bond. Errors carry a replay only while the session records. On React Native, the option is passed to the native SDKs, and `open()` maps their refusal to `EverframeReporterDisabledError`.

- 56a3a9f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Errors can carry a session replay.

  When replay is on, a handled error, and on React Native and the web an error
  the app survives, can carry the last seconds of replay from a recording
  session. There are at most 2 per session, including exports in progress. An
  open bug report that owns the buffer prevents an error replay. A replay that
  isn't ready within 3 seconds or is over 8 MB (8,000,000 bytes) is left off.
  Replay failure doesn't discard the original error: Android and iOS save it
  first with a hold of up to 5 seconds; the web queues it first and waits up to
  3 seconds before sending. Android and iOS take an independent snapshot while
  recording continues, so a later error or bug report still has the history.
  Fatal native and React Native errors and Flutter apps don't attach error
  replays. Web error replays require `CompressionStream`.

  Native video replay adds 1 and 2 frames per second, with 2 as the server
  default for SDKs that support it. The iOS fallback remains 5 fps when the
  server omits the native-video setting; Android requires that setting to record
  native video. The bitrate scales down below 5 fps. Recording now also pauses
  in iOS Low Power Mode, in Android Battery
  Saver and at Android's `MODERATE` thermal status or higher (Android 10+), and
  never starts on Android low-RAM devices. Web recording pauses while the tab
  is hidden.

  Web replay masks form input values again, leaves out elements marked
  sensitive, and removes recognized card-number, JWT, bearer-token and
  email-address patterns, while other text stays readable. Sensitive markers
  added during recording also apply.

  See [session replay](../docs/session-replay.md) for settings and privacy
  boundaries.

  Recording cost is unmeasured on physical devices: the numbers so far come from an Android emulator and the tvOS simulator, at 5 and 10 frames per second.

- 01c173d: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Every Everframe package now ships on one version line. The web, React, React Native, identity, Roku and Vega SDKs, the CLI, the Metro, bundler and Expo plugins, and the Android, iOS, Flutter and KMP SDKs all release with the same version number. The CLI and the Expo plugin pin the `dev.everframe` Gradle plugin of their own version.

  The SDK key is `sdkKey` everywhere. The `apiKey` config field is gone from `@everframe/web`, `@everframe/react` and `@everframe/react-native`, along with `resolveSdkKey`. On iOS, `EverframeConfig(appId:)`, its `appId` property and the `ReplaySession` initializers that took `apiKey` are gone; use `EverframeConfig(sdkKey:)`.

  `EverframeConfig` on Android has only its primary constructor and generated `copy`. The extra constructors and `copy` overloads that kept the signatures of earlier releases are removed, so Java callers pass every constructor argument. The generated protocol models on Android and iOS likewise keep only their current constructors and initializers.

  `attachReactTree` and `detachReactTree` are removed from the Android and iOS SDKs; nothing in a report used the tree. `@everframe/web` removes `handleReportSubmit`, `bakeBlurRegions` and `REPORTER_TOKEN_STORAGE_KEY`, and its reporter token is read only from the key scoped to the SDK key.

  `everframe setup react-native` and the Expo plugin write the short native setup and rewrite their own generated lines on a re-run.

  React Native configures native only through the blocking `configureSync`; the void `configure` method is gone from the TurboModule spec and both bridges. Error capture always uses the bridge's current methods, so `getErrorCaptureStatus()` no longer has a `legacyAttempted` counter, and `getReportDeliveryStatus()` reports a missing native getter as `unavailable/native-call-failed`. The Android bridge opens the reporter only through `ReporterResolverInstaller.openForActivity`.

  Android no longer imports the plaintext outbox files that earlier builds wrote. `CrashSidecar.hydrateInto` and the `Unit`-returning `CrashSidecar.appendSync` are removed; use `appendSyncAccepted`. The report delivery status drops the queue's `migration` field on Android, iOS and React Native.

- 08f1b47: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Errors now carry a session replay when the page is recording one. This covers `window.onerror`, unhandled rejections, `captureException` and React render errors that no error boundary caught. The replay covers the app's replay duration up to the error and is the same rrweb attachment bug reports use. Taking it does not stop or reset recording. At most 2 errors per page load get a replay. None is taken while the bug reporter is open, or in browsers without `CompressionStream`, and the error waits at most 3 seconds for it. A replay over 8,000,000 bytes, or one not ready in time, is left out and the error is flagged `replayOmitted`. Replay stays off unless the app turns it on, and the existing sampling rate applies.

- 5ee0f0f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Web session replay no longer records while the tab is hidden. Hiding the tab stops recording and drops the rolling window. Showing it again starts a fresh recording with a full snapshot.

- 78bf1a5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Web session replay now masks before anything leaves the browser, for bug reports and error replays alike. Every form input value is masked, and checkbox, radio and select state is not recorded. Elements marked sensitive (`data-everframe-sensitive`, `<Sensitive>` or `sensitiveRegistry`) are blocked, including ones that appear after recording starts. Card numbers, JWTs, bearer tokens, US SSNs and email addresses are removed from all recorded text and attributes. Other page text stays readable. Until now web replay recorded text and input values raw.

## 1.2.0

### Minor Changes

- b90da7c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Envelopes carry `context.app.debug` when the SDK detects a debug build, and release-health records move to schema version 5 with a required `app.debug`. Everframe never creates a release from a debug build.

- 5ec828c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The SDK key is renamed to `sdkKey` in every SDK; `apiKey` and `appId` are still accepted but deprecated. `appId` now means only the App ID, the UUID that symbol and source-map uploads take.

  - Web, React and React Native: the config field is `sdkKey`, for example `init({ sdkKey: 'evf_live_…' })` and `<EverframeProvider config={{ sdkKey: 'evf_live_…' }}>`. A config that still passes `apiKey` keeps working: the SDK reads it as `sdkKey` and logs one deprecation warning. When both are set, `sdkKey` wins.
  - iOS and tvOS: `EverframeConfig(sdkKey:)` and `.sdkKey` replace `EverframeConfig(appId:)` and `.appId`, which still compile with a deprecation warning. `EverframeConfigError.missingAppId` is now `EverframeConfigError.missingSdkKey`. `ReplaySession(baseURL:sdkKey:locallyDisabled:)` replaces the deprecated `apiKey:` spelling.
  - Android: `EverframeConfig(appId, sdkKey)` already used these names and is unchanged. Internal `ReplaySession`, `ReplayConfigProvider` and `VitalsTransport` parameters named `apiKey` are now `sdkKey`.
  - React Native requires native Everframe 1.2 on iOS and Android, the release that adds `EverframeConfig(sdkKey:)`. The Flutter iOS plugin requires native 1.2 through CocoaPods and SwiftPM, and the KMP Swift driver needs it too. These bridges, and their web counterparts, pass the key under the new name.

  Nothing on the wire changed. Requests still carry the key as `Authorization: Bearer <key>`, and the web vitals beacon still sends it in the `apiKey` body field, so clients on 1.1.0 and earlier keep working against the same server.

- a6880a2: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Web and React release health is removed. `setupReleaseHealth` and its `ReleaseHealthOptions`, `ReleaseHealthDiagnostics` and `ReleaseHealthHandle` types are no longer exported, the `releaseHealth` option is gone from `init()` and `EverframeProvider`, and the handle `init()` returns no longer has `releaseHealth`. TypeScript callers that still pass the option get a compile error; in JavaScript the option is ignored and opens no browser storage. Release health now counts foreground sessions on Android, iOS and React Native only; errors in a web app still show up under Errors.

### Patch Changes

- 7210db5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The built-in JWT redaction now checks structure instead of a regex. A header.payload.signature (or five-segment JWE) is redacted only when its header decodes to a JOSE header: optional JSON whitespace, `{`, and an `"alg"` member, as RFC 7515 and RFC 7516 require. Tokens with whitespace in or before the header JSON, an empty payload object (`e30`), an empty signature, or text glued before them (`x_`, `token`, `%3D`, `=`, `\n`) are redacted, and only the token is replaced. Dotted class, package and module names, bundle IDs and version strings, such as `dev.example.app.MainActivity$onCreate$2`, `kotlinx.coroutines.internal.DispatchedTask` or `1.2.3.4567890`, are no longer replaced with `[REDACTED:JWT]` in stack frames, messages, breadcrumbs and logs. The Android, iOS and JavaScript SDKs run the same linear-time scanner (`redactJwt` in `@everframe/protocol`, `JwtScan` on Android and iOS), checked against one shared corpus; the `jwt` entry in the shared redaction patterns names the scanner and keeps only a candidate regex.

- 3cfc899: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  React: an error that no error boundary inside `EverframeProvider` catches (thrown while rendering, in an effect or in a lifecycle method) is now reported as a fatal crash (`source: 'crash'`, `fatal: true`, mechanism `onerror`) with React's component stack after the message, `This error is located at:`. No error boundary is needed. Before, nothing was sent: React unmounts the whole tree, the provider included, in the same commit that reports the error, and the provider's unmount discarded the report while it was still being saved. A provider unmount now only stops new capture; a crash report already accepted is still saved and sent, and a failed send goes out on the next page load. Only `kill()` (and `destroy()`) still cancel it. The provider then hands the same error on, so an error boundary around the provider still catches it, and otherwise React reports it to the page as before; that second sighting is not reported again. Errors that a boundary inside the provider catches are unchanged. A React 18 development build reports a failed render or effect to `window.onerror` before any boundary sees it, so in development such an error can still arrive as a non-fatal error, instead of or as well as the fatal report.

## 1.1.0

### Minor Changes

- 93308e3: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Publish the build-artifact tooling. `@everframe/metro` stamps a build identity into Hermes bundles at bundle time, `@everframe/expo` adds the native build steps that collect the bundle, source map and native identifiers, and `@everframe/cli` verifies and uploads them so release crashes symbolicate. `@everframe/react-native` now reads the identity injected by `@everframe/metro`, so no build ID needs to be passed at runtime.

  `@everframe/bundler-plugin` adds Vite, Rollup, webpack, esbuild and Next.js plugins that stamp a build ID into web bundles and upload their source maps at the end of a production build. `everframe upload-expo-export` uploads the bundles and source maps from an `expo export` directory. `everframe setup react-native` patches the Gradle and Xcode build steps so native release builds collect and upload their artifacts.

### Patch Changes

- a5e45fd: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Mobile crash reports now include the error's cause chain. React Native sends `Error.cause` chains through the existing native bridge, including the stacks Hermes exposes on `Error.prototype`. Android captures `Throwable` causes next to the existing JVM metadata, and iOS follows the `NSUnderlyingErrorKey` of `NSError` and `CustomNSError` errors. Each chain keeps at most 8 causes, 32 frames per cause and 65,536 serialized UTF-8 bytes, is redacted before it is stored, and marks anything it drops as truncated. Malformed cause data never discards the outer report, and causes do not change how errors are grouped.

  Cause redaction scans a bounded prefix of each field (8,192 characters) and of each JavaScript stack (32,768 characters). When either limit cuts the text, the cut token and any digit group before it are dropped before redaction, so a JWT, bearer token, card number or SSN split at the limit does not reach a report. The same holds for an email address when the web SDK's `redaction.maskInputs` includes `'email'`. This applies to web cause chains as well. Custom `redaction.customRules` patterns are matched only against the retained text, so when the limit cuts a custom match that contains spaces or other punctuation, the start of that match can remain unredacted.

## 1.0.0

### Minor Changes

- e01db12: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Screenshots now render with snapDOM, which is several times faster on large pages and keeps the page responsive while capturing. The previous renderer remains as an automatic fallback for one release. A capture that comes out as a flat, single-colour image is now reported with the `screenshot_blank` degraded reason instead of being sent as a normal screenshot.

- 9332f80: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Smart-TV web apps can now have their screenshots rendered from a masked page snapshot instead of on the TV, when server-side rendering is enabled for the project: faster, faithful to the TV's fonts, dark mode and focus highlight, and never a blank image. Sensitive elements and input values are masked inside the snapshot, and the snapshot is attached to a report only for screenshots that were not blurred, cropped or area-selected. Companion (phone) reports now always get an answer for a capture request, and can be sent when the TV produced no screenshot. New degraded reasons: `screenshot_render_failed` and `screenshot_unavailable`.

### Patch Changes

- e16f94b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fixed the screenshot annotation tool failing to load. It depended on a newer release of the canvas library that requires React 19.3 or later, so it never opened when the bundled or installed React was 19.2. The canvas library is now pinned to the release that matches React 19.2.

- ccc4581: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add a React Native browser entry that re-exports the React SDK through the same package import. Align sensitive wrapper and ref names across native and web, and include the React SDK as a dependency so web hosts install one Everframe package.

- 9a40051: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Screenshots, page snapshots and session-replay attachments now work on pages served over plain `http://` (common for hosted smart-TV apps). Their SHA-256 digests fall back to a built-in implementation when the browser's Web Crypto `crypto.subtle` is unavailable, instead of failing the capture.

- b90124f: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Smart-TV engines down to Chrome 53 (webOS 4):

  - The SDK loads again: a regular expression using lookbehind and Unicode property escapes no longer stops the module from loading.
  - Reports with a focused element are no longer rejected: the focus position is read from `left`/`top`.
  - The TV snapshot path no longer uses `trimEnd`, `globalThis` or `padStart`.
  - On weak TV profiles, pages above 1,000 elements skip the page snapshot instead of freezing the app for seconds, and the snapshot scrub is faster on pages that repeat styles.
  - On-device screenshots place sensitive-content masks from `left`/`top`, so they land correctly on engines whose `ClientRect` has no `x`/`y`; a sensitive area without a finite position now fails the screenshot instead of shipping it unmasked.

- 6f7b70c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Fix `@everframe/react` ignoring reporter branding and companion state. The `@everframe/web/ui` entry kept its own copies of the branding and companion stores, so the React reporter dialog never picked up the dashboard theme, the `theme` option or the watermark setting, and the companion badge and PIN card never saw a running companion session. `/ui` now reads these stores from the main `@everframe/web` entry, so there is one instance of each on the page.

## 0.9.0

### Minor Changes

- b375364: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Rename the public SDKs, native bridges, package coordinates, and documentation to Everframe.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/web

## 0.8.2

### Minor Changes

- 41f87fe: Make the web report hotkey dashboard-controlled, with `Mod+Shift+B` as the
  default binding for existing and new apps. Web and React SDKs now apply remote
  binding changes during live config refreshes, and the former SDK-side
  `config.hotkey` override and public `registerHotkey` helper have been removed so
  the dashboard remains authoritative.
- 061f83a: Give `@traceitx/react` the host-facing API `@traceitx/react-native` already had, and fix `setExtra` corruption.

  - `recordScreen`, `useTXScreen` and `<TXScreen>` are now available on web, deriving the same `from → to` breadcrumb the native SDKs emit. Hosts previously hand-rolled this from a recipe in our own docstring, and different hosts got different subsets of the five rules right.
  - Top-level `setUser` on web; calling it with no argument clears, matching React Native.
  - `companion.start()` no longer requires `sdkKey` / `deviceLabel` when a `<TraceItXProvider>` is mounted — it defaults them from the provider config. Explicit arguments still win, and standalone `@traceitx/web` is unchanged.
  - `useCompanion()` now reports `running`, the session intent hosts previously had to track in a module-scoped flag.

  **`setExtra`, all four SDKs (web, React, React Native, and the protocol/native ceiling underneath them):** the `extra` cap is raised from 2000 characters to 16384 (16 KiB). The 2000-char figure had no storage or ingest justification — it only existed because the native SDKs happened to truncate there — and it was the tightest budget of anything in the report payload (a single breadcrumb message alone gets 2048). If you were ever hand-trimming your own `extra` object to survive the old limit, you almost certainly don't need to anymore.

  `setExtra` accepts an object as well as a string — `@traceitx/sdk-core`, `@traceitx/web` and `@traceitx/react` already had this, and `@traceitx/react-native` now does too — so hosts stop hand-serializing JSON themselves.

  **`setExtra` also accepts a resolver — `setExtra(() => buildExtra())` — and this is now the form to prefer.** It is invoked once per report, at assembly time, never at registration time, so what it returns reflects the host's state when the bug happened rather than whenever `setExtra` last ran. The string and object forms freeze a snapshot at call time, which goes stale the moment anything changes; a host that was re-calling `setExtra` on every state change to keep it fresh can replace all of those calls with one resolver registered at startup. React Native reaches the resolver through a native ask-and-wait seam, so it behaves the same there as on the web. An over-budget payload is never sliced (slicing serialized JSON produces a fragment nothing can parse); it is OMITTED from the report instead, with a warning logged at the `setExtra` call site naming the actual size and the limit. On React Native, an over-budget **string** still crosses the bridge as-is and is truncated by the native side's own raw character cut — that native behavior is unchanged; prefer the object form there.

  `EXTRA_MAX_CHARS` is now exported from `@traceitx/react` and `@traceitx/react-native` (it was already available from `@traceitx/sdk-core` and `@traceitx/web`), so a host that wants to trim its own `extra` object can check the real limit and decide for itself what to drop — that decision needs knowledge of what the host's own fields mean, which only the host has. The SDK does not attempt this on your behalf.

- fb6e79b: **Report Resource Window: CPU and memory for the last N seconds on every report.**

  Reports and crash envelopes now carry `payload.resources` — CPU and memory
  sampled every 2 seconds over a per-app configurable window (30/60/120s,
  default 60, off by default). Configure it per app in the admin App Overview.
  The admin event drawer charts the window with a peak/average stat row.

  `cpu` is absent on web — no browser CPU API exists; web samples instead carry
  `extras.longTaskMs` / `extras.loopLagMs`.

  Session Vitals is unchanged by this release and keeps stamping `payload.vitals`
  exactly as before.

  The webhook event schema goes `1.1` → `1.2`, additive only:
  `data.report.payload.resources` joins the report payload. Nothing renamed,
  removed, or re-typed, so an existing `1.1` receiver keeps working untouched.

  ## Deploy order — REQUIRED: API before this SDK

  Deploy the API before releasing this SDK version. An API build without
  `payload.resources` in its envelope schema rejects an envelope carrying it
  with a non-retryable 400, and envelope validation is all-or-nothing: the
  **entire bug report or crash report is silently dropped**, not merely its
  resources block, with no error visible to the customer or to you.

  **Minimum required API version:** an API deploy from this repo at or after
  this change merges — one that includes the `resources_enabled` /
  `resource_window_sec` migration, serves the negotiated `resources` config
  block, validates `payload.resources` from this same `@traceitx/protocol`
  release, and delivers webhook schema `1.2`.

- 6f23344: **Playback sessions can now be attributed to the person who was watching.**

  A session carries the end user's identity, through the same two tiers reports
  already use: the verified identity token, or a self-declared `user` block.
  Self-declared identities are shown with an "unverified" badge — the claim rides
  under the publishable SDK key, so it is a claim, never authentication.

  Identity is sent with the session SUMMARY only, never with individual chunks.
  Sessions from SDKs that do not send identity stay anonymous, which is ordinary
  and expected.

  **React Native is not covered by this release.** It is in the same fixed version
  group, so it bumps to the same version, but it gains nothing here: there is no
  JS vitals collector on React Native — `src/vitals.ts` is a thin TurboModule
  forwarder over the native collectors — so parity means adding identity to the
  Android and iOS collectors and their wire codecs. That is separate, and much
  larger, work.

  ## Deploy order — REQUIRED: API before this SDK

  Deploy the API before releasing this SDK version, and apply migration `0091`
  before that API boots.

  The fetch path now sends `X-TX-Identity-Token` on the vitals summary, and that
  header is not in the `Access-Control-Allow-Headers` allow-list of any API build
  predating this change. Omitting a header from that list does **not** merely
  strip the header — it fails the CORS **preflight** outright. So a customer on
  this SDK with verified identity tokens loses the ENTIRE cross-origin summary,
  and the summary is the session row's only source of dims and metrics: the
  sessions go blank, not merely unattributed.

  Customers on the self-declared tier, or sending no identity at all, are
  unaffected — the protocol objects strip unknown keys, so an old API silently
  ignores `user` and `identityToken`.

  Migration `0091` adds `vitals_sessions.reporter_identity_id`. The new API's
  summary INSERT lists that column unconditionally, so booting the new API
  against an un-migrated database fails every summary write.

  **Minimum required API version:** an API deploy from this repo at or after this
  change merges — one with migration `0091` applied, `X-TX-Identity-Token` in the
  vitals CORS allow-list, and the summary-path identity resolution.

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

- 4d5554c: **Session Vitals: per-player playback tracking (hls.js, Shaka, and native).**

  `trackPlayer({ element, hls, name })` (and the Shaka/native/custom-integration
  equivalents) attaches per-player identity to Session Vitals: source, DRM,
  bitrate ladder, startup timing breakdown (`manifestMs`/`firstFragmentMs`/
  `licenseMs`), and dropped-frame/quality stats, alongside the phase-3
  element-level play/pause/buffer/seek tracking. `trackVitals(name, data)` logs
  a customer structured entry (session- or player-scoped) onto the session
  timeline. `@traceitx/react` gains `useTrackPlayer`, and the admin Sessions
  tab gains a per-player timeline, a Players panel, and a player-count badge
  inside the session list's existing Integration cell (no new column).

  ## Deploy order — REQUIRED: API before this SDK

  **Deploy the API before releasing this SDK version. This is a hard
  precondition, not a nice-to-have**, and getting the order wrong is worse than
  "vitals are lossy" the way earlier phases could be:

  - An old API rejects a phase-4 `VitalsEntry` (the new `playerId`, `custom`
    entries, and player event types, plus `vitals_sessions.player_count` from
    migration `0082`) with a non-retryable 400. On the **vitals chunk/summary
    path alone**, that is merely a blank vitals timeline for the session — bad,
    but recoverable.
  - It is NOT alone. `stamp-active-vitals.ts` stamps the collector's
    recent-entries ring onto `payload.vitals` on **every bug report and crash
    envelope**, and the envelope validates that field against the exact same
    `VitalsEntry` union. A phase-4 SDK emits a player `stats` entry every 20
    seconds, so almost any session with a player attached has at least one
    entry an old API's narrower union rejects — and envelope validation is
    all-or-nothing. That rejects the **entire report or crash envelope**, not
    just its vitals block: **a customer's bug report or crash report is
    silently dropped**, with no error visible to them or to you.

  **Minimum required API version:** an API build that already includes
  migration `0082` (`vitals_sessions.player_count`) and validates the phase-4
  `VitalsEntry`/`SessionSummary` shapes from this same `@traceitx/protocol`
  release — i.e. any `the ingest API` deploy from this repo at or after this change
  merges. Confirm that build is live in production before publishing this SDK
  version to customers; do not publish it otherwise.
