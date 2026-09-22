<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @scriptx-com/traceitx-react

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

## 0.6.4

### Patch Changes

- 95d98b9: Fixed: importing the React SDK no longer crashes on older browser engines that do not provide `BigInt`.

  The SDK's bundled Zod runtime now creates its bigint format limits only when a bigint schema uses them, instead of evaluating `BigInt(...)` while the package is imported. Applications no longer need to patch the published SDK after installation to boot on those engines.

## 0.6.3

## 0.6.1

### Patch Changes

- b638494: Fixed: a `<video>` on the page could hang web screenshot capture forever, leaving the reporter stuck on "Capturing report context…".

  `modern-screenshot`'s clone step assigns `currentTime` on its copy of each `<video>` and then awaits a `seeked` event. Per the HTML spec, seeking a media element whose `readyState` is `HAVE_NOTHING` sets the default playback start position and returns **without firing `seeked`** — so the promise never settled. Because it was a hang rather than a throw, neither the internal `try/catch` nor the reporter's `.catch()` could recover, which put both the html-to-image fallback and the degraded-screenshot path out of reach.

  Any `<video>` at `readyState 0` triggered it, including ordinary cases: a player that has not been handed a stream yet, one whose source is still loading or has stalled, an MSE/HLS element with nothing buffered, and even a `<video>` with no `src` at all.

  `<video>` elements are now excluded from both capture libraries. For the duration of the capture each one is paired with a same-sized stand-in element carrying its current frame, read straight off the live element with a synchronous `drawImage` that cannot block. Screenshots keep showing video content and the page's layout is unchanged; where a frame cannot be read the region degrades to the element's poster, or to a neutral placeholder:
  - **cross-origin video** no longer destroys the entire screenshot. Reading such a frame taints the canvas, which previously made html-to-image throw `SecurityError` and lose the whole capture; the taint is now detected and that one region degrades on its own.
  - **stalled or broken sources** no longer cost a flat 30s. The capture library waits for every `<img>`/`<video>` in the subtree _before_ consulting its node filter, so excluding videos alone was not enough; that wait is now bounded too.
  - The capture as a whole now runs under a wall-clock deadline, so any other unbounded path inside either library degrades to a placeholder screenshot instead of stalling the reporter indefinitely.

  Videos inside a masked or `data-traceitx-skip-capture` subtree keep their layout box but show nothing, and neither does one the page itself is not painting (`visibility: hidden`, `opacity: 0`, `content-visibility: hidden`, or a collapsed `clip`). The opt-out attribute also now works when placed on a web component's host, for videos inside its shadow root.

  The video element is never detached, so playback and any MSE/HLS session survive the capture. While it runs, the live page shows the stand-in in place of the video, so motion appears to freeze briefly — under the reporter this sits behind the modal.

  If you added an app-side workaround that tags `<video>` elements with `data-traceitx-skip-capture` to avoid this hang, you can remove it — though leaving it in place is harmless and still opts those elements out.

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

- 8e53a03: Add `@traceitx/identity` — mint TraceItX identity tokens from any runtime with
  one `createIdentityHandler({ secret, projectId, resolveUser })` call, plus the
  `identity={{ endpoint, key }}` prop on `TraceItXProvider` that replaces the
  hand-written `setIdentityToken` effect. `headers` is re-invoked on every mint,
  so rotating access tokens work; cookies are no longer assumed.

## 0.4.0

### Minor Changes

- a2ccfec: The in-memory console-log buffer now keeps only the last 100 entries (was 250), matching the network buffer — oldest are evicted from memory so logs never accumulate. The 4000-char envelope trim still applies on top at send time. Override via `config.console.maxEntries` is unchanged.
- 81130a3: Captured console logs are now trimmed before they ship in a report: the most recent entries up to 4000 total message characters are kept, and everything older is collapsed into a single `"REDACTED"` marker entry at the front. This stops noisy apps from ballooning the envelope (previously tens of thousands of JSON lines just from logs).

  Each log now stores only a single rendered `message` — the duplicate `args` array is gone, and `%s`/`%d`/`%o` placeholders are substituted into the message (console-style), so the useful values (e.g. a React warning's prop name) are preserved instead of shipping a raw `%s` template plus a duplicate array.

## 0.3.5

### Patch Changes

- 68807ba: BREAKING: rename the SDK key config field `key` → `apiKey` (now required), matching the React Native SDK so both share one config shape.

  `<TraceItXProvider config={{ key: '…' }}>` must become `<TraceItXProvider config={{ apiKey: '…' }}>`. There is no back-compat alias — `key` is removed. This also fixes configs that set `apiKey` (the RN field name) silently sending `Authorization: Bearer undefined` and getting 401s from ingest.

- 64dfa52: Reporter modal now handles Escape through a shared layer stack and `preventDefault()`s the event so the host app's own Escape listeners don't also fire (previously the modal only `stopPropagation`'d, letting window-level app handlers interfere). Escape while the fullscreen annotation overlay is open now "goes back" to the reporter modal instead of closing the whole reporter; with a discard-confirm open, Escape dismisses that first (LIFO). The single capture-phase listener also suppresses the browser default.
- 68807ba: BREAKING: `useTraceItX().setMetadata(Record<string,string>)` is removed and replaced by `setExtra(value: string)`, matching the React Native SDK's hook surface. Unlike the old `setMetadata` (which never reached the report), `setExtra` now actually lands its string in `payload.extra` (capped at 2000 chars), so host metadata is finally sent on web. Callers JSON.stringify nested data themselves.

  Migration: `setMetadata({ a: '1' })` → `setExtra(JSON.stringify({ a: '1' }))`.
