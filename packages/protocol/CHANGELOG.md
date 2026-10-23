<!-- SPDX-License-Identifier: MIT -->

## 0.10.0

### Minor Changes

- dc725fc: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  JavaScript source maps (web, Hermes and Vega) may be up to 256 MiB each (from 32 MiB), and a web build's maps up to 1 GiB together (from 256 MiB). Release React Native maps had grown past 32 MiB, so `build collect` and `sourcemaps upload-hermes` failed with `source_map_too_large`. The CLI now streams every source map from a private snapshot and sends it gzip-compressed when the server lists `gzip` in `uploadEncodings`. Upload these maps only to an Everframe API that accepts the larger limit.

- 599b372: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Envelopes may carry an optional `quickCapture` boolean, set when a report is filed by the debug quick-capture trigger instead of the reporter UI. The generated Swift `EverframeReportEnvelope` memberwise initializer gains a `quickCapture` parameter, so code that constructs the envelope directly must pass it.

## 0.9.0

### Minor Changes

- e63aae4: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add bounded typed state labels and automatic facts for React Native iOS/Android reports, with native snapshots, history checkpoints and persisted crash observations.

## 0.7.0

### Minor Changes

- e0c884b: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android crash capture is now on by default with `capture.crash`. `Everframe.start` captures JVM exceptions, native crashes (OS exit records on API 30+, with tombstone frames on API 31+) and ANRs on API 30+, without any other call. From OS exit records it reports native crashes, ANRs, and low-memory kills while the user could see or hear the app (foreground, foreground service or visible), the last as one fatal "Low memory kill" crash per app with importance, PSS/RSS and the exit description, and not when the JVM handler already reported that process's crash; background reclaims, user stops, JVM crash exits and other reasons are not sent. The protocol lets a crash envelope carry low-memory exit evidence. The optional `dev.everframe:native-crash` module (not yet on Maven Central) adds a fault frame for native faults on API 26–30. Native and OS exit capture run in the default app process. `setProcessExitDiagnosticsEnabled`, `setNativeCrashRecoveryEnabled`, `setNativeSignalCaptureEnabled` and their three readiness getters are removed; `Everframe.isNativeCrashCaptureReady()` replaces the getters. Start with `CaptureConfig(crash = false)` to turn capture off, or call `kill()`. The SDK now owns `ActivityManager.setProcessStateSummary` while capture is on and logs `process-state-summary-conflict` when another writer replaced it; a writer that runs before the SDK is overwritten. Flutter gains `start(crash:)` (default on), which reaches the native `capture.crash` on Android and iOS. In React Native, `crashReporting: { disabled: true }` now also turns off native crash and ANR capture on Android and iOS. A full OS exit journal no longer stops capture: arming frees only the slots it needs, records that can no longer be reported first, oldest first by arming order, never the newest, and logs a warning. Crash matching and expiry no longer depend on the wall clock: a matched crash is reported however far the clock jumped (and is never collected before its own exit time), and an unmatched record expires once the clock is more than 14 days from its creation in either direction.

- ca7cd1a: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Add `payload.inferredTermination`, the next-launch evidence for an iOS or tvOS foreground process that the OS killed without a crash report (low memory, unresponsive or unexplained). It rides on its own anonymous, stackless fatal crash with mechanism `apple-termination-inference` and one fingerprint per cause, never Android's low-memory group. Generated Swift and Kotlin payloads keep their previous initializers and constructors.

- b90da7c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Envelopes carry `context.app.debug` when the SDK detects a debug build, and release-health records move to schema version 5 with a required `app.debug`. Everframe never creates a release from a debug build.

- 423e77c: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Builds can upload their native symbols automatically, and a symbol problem never breaks a build by default.
  - `everframe dsym upload-build` finds the binaries and dSYMs itself: `--xcode` inside a Run Script phase, `--archive` for an `.xcarchive` (fastlane, Xcode Cloud, CI) and `--app` for any other layout. App and extension executables are required. Embedded frameworks are optional and warn when they have no dSYM. dSYM folders are searched recursively. iOS, tvOS and their simulators are supported.
  - `everframe setup xcode` adds an "Upload Everframe Symbols" phase to every application target, and `--print-script` prints it for XcodeGen. The phase turns off user script sandboxing on those targets and declares a dSYM input only for `dwarf-with-dsym` builds.
  - The React Native and Expo build phase also uploads iOS dSYMs, skips Debug builds, reads flavored Android variants such as `tvRelease`, and turns off user script sandboxing.
  - `everframe elf upload-build --binaries-dir` finds every shipped `.so`, limited to `--abi` when given. Prebuilt libraries without debug information are listed, not warned about; `--summary` prints one `detail:` line per library for build integrations.
  - In `--xcode` mode, `everframe dsym upload-build` also follows the app's run-path links to frameworks that are built but not embedded yet, such as CocoaPods frameworks under `use_frameworks!`, and uploads their dSYMs from the build products.
  - R8 mappings may be up to 512 MiB (from 32 MiB). The CLI streams them and sends them gzip-compressed when the server lists `gzip` in `uploadEncodings`. A mapping over the limit fails with `r8_mapping_too_large`, naming the file, its size and the limit.
  - The `dev.everframe` Gradle plugin uploads R8 mappings and native libraries after `assemble<Variant>` and `bundle<Variant>` of release builds through a new `everframe {}` block. The R8 mapping ID is the SHA-256 of `mapping.txt`, packaged with the app, so `Everframe.start` reports it without `r8MappingId`. `everframeR8 {}`, `EVERFRAME_R8_BUILD_ID` and the `EVERFRAME_R8_MAPPING_ID` BuildConfig field are removed. React Native and Expo projects apply the plugin. Native uploads consider only the ABIs the variant packages, and libraries without symbols produce one warning with a count; `--info` lists them.
  - Build integrations warn and exit 0 when `EVERFRAME_API_TOKEN` is missing or an upload fails. They upload every file that matches before reporting misses, and stop after `EVERFRAME_UPLOAD_TIMEOUT_SECONDS` (600 by default). `--strict` or `EVERFRAME_SYMBOLS_STRICT=1` turns these into failures.
  - Every request now has a timeout, and `upload_busy` responses are retried for as long as their `Retry-After` and the time budget allow.

- 0fd1ce9: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Release health is keyed by app version. It is on by default; see the release health on-by-default changeset for how to configure or turn it off.

  Release-health records are schema version 4 only, for Android and iOS foreground sessions. Each record carries `app: { version, build }`, which the SDK reads itself: Android's `versionName` (or `versionCode` as text when there is no usable `versionName`) and `versionCode`, and iOS's `CFBundleShortVersionString` (or `CFBundleVersion`) and `CFBundleVersion`. `nativeRelease`, the version 1–3 records and the web records are removed, so a receiver accepts version 4 only. Crash and error reports' `context.app.version` follows the same rule: an Android app without a usable `versionName` now reports its `versionCode` there, and an iOS app without `CFBundleShortVersionString` its `CFBundleVersion`, instead of `0.0.0`.

  The crash pointer, `NativeExposurePointerSchema`, carries the same `app` in place of `nativeBuildId`. `build` is always present and is `null` when there is none. The generated Kotlin `NativeExposureApp` and Swift `EverframeNativeExposureApp` write that null explicitly, and the generated `App` and `EverframeApp` keep their names.

  The `release_health.threshold_reached` webhook moves to event schema 2.0. One project rule sends one event per app version that drops below its crash-free target, with the version's platforms, the target, the last 7 days' session counts and `crashFreeSessions`. `RELEASE_HEALTH_ALERT_SCHEMA_VERSION` and `ReleaseHealthAlertTargetSchema` are new. The cohort schema and the `release_health.rate_threshold_reached` event are removed, and every other webhook event stays at 1.2.

  `nativeBuildId` is removed from every SDK. In React Native, the unused `appVersion` and `appBuild` options are removed too.

- 95c25da: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Accept `vega` (Amazon Vega OS) as an SDK platform and `everframe-vega` as an SDK name. Hermes bundle metadata, Hermes asset URLs and version-2 source-map manifests accept the `vega` platform. The crash-details sensitive-key list and its matcher are exported (`SENSITIVE_KEY_PARTS`, `isSensitiveKey`) from a module without zod.

### Patch Changes

- 4fc7221: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Android OS exit evidence (`payload.diagnostic.android`) gains an optional `mappingId`: the R8 mapping ID of the build the exited process ran, in the same format and from the same source as a JVM crash's `payload.crash.jvm.mappingId` (the ID the Everframe Gradle plugin packages in the APK, or `EverframeConfig.r8MappingId`). The SDK freezes it when the process arms exit capture, so an ANR, a low-memory kill or a native crash reported on the next launch names its own build's mapping even after an update, and an ANR stack can be retraced without a Java crash from that build. The generated Kotlin `Android` and Swift `EverframeAndroid` evidence types gain the field.

- 7210db5: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  The built-in JWT redaction now checks structure instead of a regex. A header.payload.signature (or five-segment JWE) is redacted only when its header decodes to a JOSE header: optional JSON whitespace, `{`, and an `"alg"` member, as RFC 7515 and RFC 7516 require. Tokens with whitespace in or before the header JSON, an empty payload object (`e30`), an empty signature, or text glued before them (`x_`, `token`, `%3D`, `=`, `\n`) are redacted, and only the token is replaced. Dotted class, package and module names, bundle IDs and version strings, such as `dev.example.app.MainActivity$onCreate$2`, `kotlinx.coroutines.internal.DispatchedTask` or `1.2.3.4567890`, are no longer replaced with `[REDACTED:JWT]` in stack frames, messages, breadcrumbs and logs. The Android, iOS and JavaScript SDKs run the same linear-time scanner (`redactJwt` in `@everframe/protocol`, `JwtScan` on Android and iOS), checked against one shared corpus; the `jwt` entry in the shared redaction patterns names the scanner and keeps only a candidate regex.

## 0.6.0

### Minor Changes

- 5777c38: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Adds `MAX_DOM_SNAPSHOT_DEPTH` (1024) and `domSnapshotDepth`, so a page snapshot deeper than a server render accepts can be rejected on the device instead of failing after upload.

- d72fddf: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Adds the `dom-snapshot` attachment kind and a versioned page-snapshot format (`DomSnapshotV1`, validated by `parseDomSnapshot`) for smart-TV screenshots that are rendered on the server, together with the render endpoint's request and response types and the shared report limits (`MAX_REPORT_SHOTS`, `MAX_INGEST_FILE_PARTS`). Report upload now labels `dom-snapshot` and `dom-snapshot-N` parts with their own kind. Existing reports and SDK behaviour are unchanged.

- 5ad9926: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  Accept `roku` as an SDK platform and `everframe-roku` as an SDK name.

- 89edce8: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Companion relay frames can now describe a capture that produced no image: `report.assembled` gains an optional `outcome` (`image`, `snapshot` or `unavailable`), `degraded_reason` and a snapshot reference, and `report.submit` gains per-shot `has_image` and redaction state so a device only waits for the images that will actually arrive. Existing frames are unchanged and still valid.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/protocol

## 0.5.0

### Minor Changes

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

## 0.4.0

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

## Unreleased

- Remove retired `payload.uiTree`, `payload.reactTree`, and `payload.reportTarget`
  from the schema and generated native models. This intentionally removes the
  corresponding Swift initializer arguments and legacy payload overloads.
  Unknown historical JSON still parses, but native models do not re-encode it.
  Web rrweb and Android's separate replay format are unchanged.

## 0.3.0

### Minor Changes

- 8159f83: Companion attach now requires device consent: attaching from the dashboard
  shows a 4-digit code on the device (rendered by the SDK by default;
  `attachPinUi: 'custom' | 'off'` to override) that the dashboard member must
  type. Devices on older SDK versions keep one-click attach.
