<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe for Android

Native Android SDK for Everframe — in-app bug reporting with annotated screenshots,
session replay, log/network ring buffers, and a built-in Compose reporter UI.
Covers phone, tablet, and Android TV.

Maven Central serves version `1.1.0`, including the shorter Gradle plugin
artifact name.

---

## Maven coordinates

| Module                       | Purpose                                                                      | Required? |
| ---------------------------- | ---------------------------------------------------------------------------- | --------- |
| `dev.everframe:core` | SDK kernel: capture, envelope, transport, outbox, OkHttp interceptor         | yes       |
| `dev.everframe:protocol` | quicktype-generated kotlinx-serialization data classes for `ReportEnvelope` | transitively via `-core` |
| `dev.everframe:reporter-ui` | Compose Material 3 reporter UI for phone + tablet (bubble, modal, annotation) | yes for in-app reporting |
| `dev.everframe:media3` | Media3 and ExoPlayer diagnostics | optional |
| `dev.everframe:gradle-plugin` | Optional R8 keep rules and Compose display name preservation | optional; available with 0.10.2 |
| `dev.everframe:native-crash` | Native fault frames on Android 8–11 (API 26–30); needs `useLegacyPackaging = true` | optional; not yet on Maven Central, see [`../native`](../native/README.md) |

Android modules ship under one version. The older `0.10.0` plugin uses the
older `dev.everframe:everframe-gradle-plugin` artifact; Gradle plugin users keep
the same `id("dev.everframe")` when moving to `0.10.2`.

---

## Quick start

### 1. Add Maven Central

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
```

### 2. Add dependencies

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("dev.everframe:core:1.1.0")
    implementation("dev.everframe:reporter-ui:1.1.0")
}
```

`core` declares `android.permission.INTERNET`, and the manifest merger adds it to
your app. SDK 1.1.0 and earlier do not: with those, declare it in your app's
`AndroidManifest.xml`, or the SDK sends nothing.

### 3. Initialize at startup

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Everframe.start(
            this,
            EverframeConfig(
                appId = "<App ID>", // the UUID on the app's Setup tab in the dashboard
                sdkKey = BuildConfig.EVERFRAME_SDK_KEY,
                environment = Environment.production,
                // Exact public identity of this optimized build's R8 mapping.
                // Generate a fresh value in CI for every distinct mapping.txt.
                r8MappingId = BuildConfig.EVERFRAME_R8_MAPPING_ID,
                // Hint to the host that a bubble UX is desired. Only mobile
                // shake-to-report is built in; the bubble remains host-owned.
                bubble = true,
            ),
        )
    }
}
```

`start()` is synchronous and returns in <5ms (heavy work runs on a coroutine
scope). It throws `EverframeConfigError` on bad config — let that exception
escape; the SDK never crashes the host app from inside `start()`.

Crash capture — JVM exceptions, native crashes and ANRs — is on by default.
See [crash capture](../README.md#crash-capture-on-by-default).

`r8MappingId` is optional and must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` exactly. Treat it as immutable build
identity and upload the matching mapping only from trusted CI.

---

## Release health observations (opt in)

Set `EverframeConfig.releaseHealth` to monitor foreground sessions independently
of replay, session vitals, `setUser`, and install identifiers. This remains
opt-in, with anonymous subjects by default:

```kotlin
releaseHealth = ReleaseHealthConfig(
    nativeBuildId = BuildConfig.EXACT_NATIVE_ARTIFACT_ID,
    loadedBundleStatus = ReleaseHealthBundleStatus.NOT_APPLICABLE,
    // Optional: a project-local opaque account ID. Omit it for anonymous sessions.
    userId = signedInAccountId,
)
```

Supply the exact native artifact identity from your build pipeline. For a loaded
JavaScript bundle, use `KNOWN` with its actual `loadedBuildId`, or `UNKNOWN` with
no ID. A downloaded update that has not loaded is not the running build. Blank
or contradictory identities do not become ready. In a React Native app, enable
release health with the React Native Provider's `releaseHealth` option instead:
each Provider configure installs its own SDK configuration, so one without
`releaseHealth`, with `enabled: false` or with a rejected identity revokes a
native opt-in and erases its queued, undelivered records.

Schema version 3 uses `sessionPolicy: foreground-v1`. A durable start opens only
while the process lifecycle is foreground. Background closes that session with
`outcome: completed` and `endReason: background`; reentry opens a fresh exposure
UUID. Reconfiguration closes the previous foreground session with `sdk_stop`.
These boundaries describe the monitored foreground interval. They do not prove
healthy process termination. Process death leaves an unknown outcome, and a
relaunch never invents a completed end.

Foreground comes from AndroidX `ProcessLifecycleOwner`: it starts with the first
started activity and stops shortly after the last one stops, so rotation and
activity changes keep one session. App Startup attaches it in the default process
only. If the app removes `androidx.startup.InitializationProvider` or its
`androidx.lifecycle.ProcessLifecycleInitializer` entry, or enables release health
in another process, no session opens, `isReleaseHealthReady()` stays false, and an
`Everframe` warning names `process-lifecycle-unavailable`.

`Everframe.isReleaseHealthReady()` means an active foreground start has committed
to the encrypted journal. Background immediately removes its attribution pointer.
Foreground sessions persist subject/build ownership and reuse immutable bytes
and record IDs across retries. The journal is bounded to 256 records and 1 MiB,
with a seven-day local retry window; write failures can leave outcomes unknown.
`requestReleaseHealthFlush()` requests a retry with each record's frozen SDK key
and endpoint. HTTP redirects are not followed. Ordinary report uploads progress
independently while a health destination is unavailable.

Absent/disabled release health and `kill()` revoke pending health records rather
than complete sessions. `kill()` and a configuration with `enabled = false` erase
them on the calling thread before returning; this is bounded local IO and can wait
for an in-progress journal write. A start without `releaseHealth` erases them on
the SDK's IO thread. Failed erasure must complete before a later re-enable. This
control governs the health journal and future pointers. Crash and diagnostic
evidence already captured with a session pointer (uncaught JVM exceptions, native
signal and OS exit reports) keeps its immutable bytes under the separate crash and
diagnostic delivery and retention policy. Health opt-out does not erase records
already delivered to the server; server exposure erasure removes their linkage even
when an older report arrives later. `kill()` revokes both local paths.

Sessions are anonymous unless you set `userId`; it is never copied from
`setUser`. It must be nonblank, at most 128 UTF-16 units and free of
U+0000–U+001F control characters and unpaired surrogates. An invalid ID records
nothing: release health does not become ready, and no exception is thrown. The ID
is frozen for its session. On login, logout or account switch, or when the loaded
OTA build changes, call `Everframe.start` again with a copy of your configuration
whose `releaseHealth` carries the new values (`userId = null` on logout). That
restart closes the previous foreground session with `sdk_stop` and opens a new one
while foreground. Anonymous sessions never infer install identity. Queue-loss
accounting remains unavailable. These are version 3 records: the receiving
service must support version 3 before you enable them. See
[release health observations](../../../docs/release-health.md).

Uncaught JVM exceptions, OS exit recovery and diagnostics, and the optional
API26–30 signal collector carry the frozen pointer of a ready foreground session.
Crashes in background, or before a session's start is durable, carry none.
Native capture arms at start, before release-health readiness.
Entering foreground keeps native capture armed with its pointer-free context;
once the session start is durable, that context is replaced with one carrying
the pointer. Background clears the OS exit token and pauses the signal handler
before a completed end can be persisted, then re-arms a pointer-free context on
the SDK's IO thread. A native crash between that background fence and the
re-arm, or while a context is being replaced, is not captured. Recovery uses
the exact prior frozen pointer, never the relaunch session or process ID alone.

When a React Native app enables release health through the React Native
Provider, an automatic unhandled Hermes JavaScript fatal captured while a
foreground session is ready carries that session's frozen pointer if its loaded
bundle exactly matches the session's known loaded build, and marks the session
fatal. Handled errors, promise rejections, fatals captured in background or
before readiness, and fatals with a missing or different bundle identity carry
none. On API 30+, the OS exit record of the process that React Native then
terminates is reported only when it is a native crash, and can carry the
pointer too; the session still counts once. See [release health observations](../../../docs/release-health.md).

## Triggers are host-app concern

> Everframe owns mobile shake-to-report. Buttons, overlays, key listeners, and every TV trigger remain host-owned.

Shake-to-report is enabled locally by default on Android phones and tablets and
controlled authoritatively by the dashboard. Disable it locally with
`EverframeConfig(..., shakeToReportEnabled = false)`. Local `true` never
overrides a dashboard disable. It uses the optional system accelerometer,
requests no permission, declares no required sensor feature, and safely no-ops
when the device has no accelerometer. Android TV and Leanback devices are
excluded.

All other trigger detection stays in the host app. Below are the canonical
recipes the sample apps demonstrate and that real hosts can copy-paste.

Observe `report.isPresenting: StateFlow<Boolean>` so your trigger UI can
disable itself while the reporter is up.

### (a) In-screen Button (recommended primary recipe)

```kotlin
@Composable
fun DebugMenuScreen() {
    val isPresenting by Everframe.report.isPresenting.collectAsState()
    val scope = rememberCoroutineScope()
    Button(
        onClick = { scope.launch { Everframe.report.open() } },
        enabled = !isPresenting,
    ) {
        Text("Open Everframe reporter")
    }
}
```

Pointer to sample: `examples/android-compose/app/src/main/kotlin/com/example/composesample/screens/ListScreen.kt`
(the `SampleListScreen` composable). For the Java/Views sample see
`examples/android-views/app/src/main/java/com/example/viewssample/MainActivity.java`
plus the small Kotlin helper `PresentingObserver.kt` (binds `isPresenting`
collection to `lifecycleScope` + `repeatOnLifecycle`, NOT `GlobalScope`).

### (b) In-app overlay (Compose Box at app root)

For hosts that want a floating, draggable affordance without a separate
window. The bubble does NOT use `SYSTEM_ALERT_WINDOW` (anti-pattern; never
use a system overlay for a debug trigger).

```kotlin
@Composable
fun AppRoot(content: @Composable () -> Unit) {
    val isPresenting by Everframe.report.isPresenting.collectAsState()
    val scope = rememberCoroutineScope()
    Box(modifier = Modifier.fillMaxSize()) {
        content()
        FloatingActionButton(
            onClick = { scope.launch { Everframe.report.open() } },
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .padding(24.dp),
        ) { Text("🐞") }
    }
}
```

### (c) Decor-view child (full-fidelity bubble — no permission needed)

The previous Phase-5 SDK bubble was implemented this way; here is the recipe
hosts can keep using directly. The bubble lives inside the host's own window
as a child of `android.R.id.content` — NO `SYSTEM_ALERT_WINDOW` permission
needed and NO `TYPE_APPLICATION_OVERLAY` permission needed (both are
anti-patterns; never use a system overlay for a debug trigger).

```kotlin
class HostBubbleAttacher(private val app: Application) :
    Application.ActivityLifecycleCallbacks {

    override fun onActivityResumed(activity: Activity) {
        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        if (root.findViewWithTag<View>("everframe-bubble") != null) return
        val dp = activity.resources.displayMetrics.density
        val size = (48 * dp).toInt()
        val bubble = View(activity).apply {
            tag = "everframe-bubble"
            background = ContextCompat.getDrawable(activity, R.drawable.bubble_circle)
            setOnClickListener {
                (activity as? LifecycleOwner)?.lifecycleScope?.launch {
                    Everframe.report.open()
                }
            }
        }
        val lp = FrameLayout.LayoutParams(size, size, Gravity.BOTTOM or Gravity.END).apply {
            setMargins(0, 0, (16 * dp).toInt(), (24 * dp).toInt())
        }
        root.addView(bubble, lp)
    }

    override fun onActivityPaused(activity: Activity) {}
    override fun onActivityCreated(a: Activity, b: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivitySaveInstanceState(a: Activity, b: Bundle) {}
    override fun onActivityDestroyed(activity: Activity) {}
}

// In Application.onCreate():
registerActivityLifecycleCallbacks(HostBubbleAttacher(this))
```

If self-capture of the bubble is a concern, hide the bubble before calling
`Everframe.report.open()` (host's choice; the SDK no longer participates).

### (d) Android TV remote combo (canonical wiggle recipe)

Per CONTEXT D-04: alternating direction wiggle pattern, very unlikely to
occur during normal navigation. The debouncer is a small (~30 LOC effective
body) value type kept inside the sample's source tree — NOT promoted to the
SDK. Source: `examples/android-compose/app/src/tv/kotlin/com/example/composesample/tv/SampleTVDebouncer.kt`
(53 LOC including KDoc), wired from
`examples/android-compose/app/src/tv/kotlin/com/example/composesample/tv/TVMainActivity.kt`.

```kotlin
class TVMainActivity : ComponentActivity() {
    private val debouncer = SampleTVDebouncer(
        // UP, DOWN, UP, DOWN, UP, DOWN within 3000ms — alternating wiggle.
        windowMs = 3000L,
    )

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && debouncer.onKeyDown(event.keyCode)) {
            lifecycleScope.launch { Everframe.report.open() }
            return true
        }
        return super.dispatchKeyEvent(event)
    }
}

// Commented-out alternate (focus-tap conflict caveat):
// private val combo = ArrayDeque<Long>(3)
// override fun dispatchKeyEvent(event: KeyEvent): Boolean {
//   if (event.action == KeyEvent.ACTION_DOWN &&
//       event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER) {
//     val now = SystemClock.uptimeMillis()
//     combo.addLast(now); while (combo.size > 3) combo.removeFirst()
//     if (combo.size == 3 && (combo.last - combo.first) <= 1500L) {
//       combo.clear(); lifecycleScope.launch { Everframe.report.open() }
//       return true
//     }
//   }
//   return super.dispatchKeyEvent(event)
// }
```

**Reserved Android TV keys — never use as triggers** (Play Store reject
defense): `KEYCODE_BACK`, `KEYCODE_HOME`, `KEYCODE_MENU`, single-press
`KEYCODE_MEDIA_PLAY_PAUSE`. The SDK no longer validates this; the host is
responsible.

### Anti-recommendations (NONE shipped, NONE recommended)

- **System overlay window** (`SYSTEM_ALERT_WINDOW` / `TYPE_APPLICATION_OVERLAY` — anti-pattern, never use as a debug trigger): user-permission-gated, hostile UX. The SDK does NOT use it; do not add this in your host app.
- A second host-owned accelerometer listener is unnecessary; configure the
  built-in trigger instead.

### Observing `report.isPresenting`

Compose:

```kotlin
val isPresenting by Everframe.report.isPresenting.collectAsState()
```

Non-Compose (any coroutine scope):

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        Everframe.report.isPresenting.collect { presenting ->
            myButton.isEnabled = !presenting
        }
    }
}
```

Java consumers can read `Everframe.report.isPresenting().getValue()` for the
current value or use the standard `kotlinx.coroutines` Java interop to
subscribe — see the `PresentingObserver.kt` helper in
`examples/android-views/` for the canonical Flow-aware `Button.isEnabled`
binding (collection bound to `lifecycleScope`, NOT `GlobalScope`).

### `BubbleConfig` migration note (collapsed in Phase 05.1)

`BubbleConfig` collapsed to a single `bubble: Boolean` field on
`EverframeConfig` (Plan 05.1-02 Task 2). The flag is now a HINT to the host
that a bubble UX is desired — the SDK no longer installs a bubble itself.

```kotlin
// Before (Phase 5):
Everframe.start(this, EverframeConfig(
    /* … */,
    bubble = BubbleConfig(enabledOnPhone = true, position = BubblePosition.BottomRight),
))

// After (Phase 05.1):
Everframe.start(this, EverframeConfig(
    /* … */,
    bubble = true, // host-installed; see "Triggers are host-app concern".
))
```

For the cross-SDK contract statement see the top-level
[README.md](../README.md#triggers-are-a-host-app-concern).

---

## Public API

### Marking sensitive UI

Compose:

```kotlin
import dev.everframe.sensitive.txSensitive

OutlinedTextField(
    value = password,
    onValueChange = { password = it },
    visualTransformation = PasswordVisualTransformation(),
    modifier = Modifier.txSensitive(),  // bake-black in screenshots
)
```

View XML:

```xml
<!-- Wrap an EditText (or any subtree) in TXSensitiveView: -->
<dev.everframe.sensitive.TXSensitiveView ...>
    <EditText android:inputType="textPassword" ... />
</dev.everframe.sensitive.TXSensitiveView>
```

Programmatic (View tree):

```kotlin
Everframe.markSensitive(myEditText)
```

### Network capture (OkHttp)

```kotlin
import dev.everframe.okhttp.addEverframeInterceptor

val client = OkHttpClient.Builder()
    .addEverframeInterceptor()
    .build()
```

Request method, URL, status, latency, and a redacted view of headers are
recorded into a 250-entry ring buffer (configurable via
`CaptureConfig.ringBufferCapacity`). When the user opens the reporter, the
captured rows are baked into the envelope.

### Opening the reporter

Kotlin (suspend):

```kotlin
val result: ReportResult = Everframe.report.open()
```

Java (callback):

```java
Everframe.report.openAsync(new Everframe.Callback<ReportResult>() {
    @Override public void onResult(ReportResult value) { /* Submitted | Queued | Cancelled */ }
    @Override public void onError(Throwable error) { /* SDK error */ }
});
```

### Android TV

The SDK does NOT register any TV remote handler. Open the reporter from your
own `Activity.dispatchKeyEvent` override using a sample-owned debouncer — the
canonical wiggle recipe (`UP/DOWN × 6 within 3000ms`) lives in the sample app
at `examples/android-compose/app/src/tv/kotlin/com/example/composesample/tv/SampleTVDebouncer.kt`
(53 LOC; copy + adapt). See [Triggers are host-app concern](#triggers-are-host-app-concern)
below for the full Android TV recipe and the reserved-key list (`KEYCODE_BACK
/ HOME / MENU / single-press KEYCODE_MEDIA_PLAY_PAUSE`).

### Optional Gradle plugin

```kotlin
// settings.gradle.kts (or root build.gradle.kts)
plugins {
    id("dev.everframe") version "0.10.0"
}
```

What it does:
- Auto-applies `everframe-keep.pro` (a copy of `:everframe-core`'s
  `consumer-rules.pro`) to the host module's R8 keep set.
- Adds `-Xandroidx-compose-runtime-keep-all-composables` to KotlinCompile so
  composable function names survive R8 minification (used by Everframe's
  `componentPath` reflection).
- Optionally embeds and uploads the exact final mapping for selected minified
  application variants:

```kotlin
everframeR8 {
    enabled.set(true)
    buildId.set(providers.environmentVariable("EVERFRAME_R8_BUILD_ID"))
    appId.set(providers.environmentVariable("EVERFRAME_APP_ID"))
}

// In app startup:
// r8MappingId = BuildConfig.EVERFRAME_R8_MAPPING_ID.takeIf { it.isNotEmpty() }
```

CI sets `EVERFRAME_API_TOKEN` and runs
`./gradlew :app:assembleRelease :app:uploadEverframeR8ReleaseMapping`. Retain the
same build ID for retries of that build; generate a fresh ID before rebuilding.
The upload task is explicit and always contacts the service. Configure its
build type and credentials only in trusted CI.

The plugin is OPTIONAL: `:everframe-core`'s `consumer-rules.pro` already
auto-merges via the AAR. The plugin is a customer-opt-in convenience for
stricter R8 setups that prefer explicit keep files.

---

## Navigation breadcrumbs

Activity → Activity transitions are captured automatically. For everything
else — single-Activity apps — mark screens with one line; the SDK derives
`from → to` from a single global chain shared with the auto-capture.

Compose (any nav system — NavHost, state-based, Voyager, Decompose):

```kotlin
@Composable fun DetailScreen(...) {
    TXScreen(name = "Detail")   // dev.everframe.TXScreen
    ...
}
```

Pager / keep-alive containers: pass `active = pagerState.currentPage == page`.

Fragments / Views (no androidx.fragment dependency needed in the SDK):

```kotlin
override fun onResume() {
    super.onResume()
    Everframe.recordScreen("Checkout")
}
```

Jetpack Navigation, one line for the whole app:

```kotlin
navController.addOnDestinationChangedListener { _, dest, _ ->
    Everframe.recordScreen(dest.route ?: dest.displayName)
}
```

Screen names should be route identifiers, never user content.

---

## R8 / minification expectations

The published `core`, `reporter-ui`, and `media3` AARs are still shrunk by R8.
Each one now includes its exact R8 mapping as a Maven classifier, for example
`core-0.10.2-mapping.txt` alongside `dev.everframe:core:0.10.2`. R8 full mode
can show `SourceFile` in raw SDK frames; use the matching mapping file with
Android's `retrace` tool to recover the original Kotlin filename, method, and
line. Keep your app's own R8 mapping too if you minify the final APK.

`:everframe-core` ships a `consumer-rules.pro` that auto-merges into your
release R8 config when you depend on the AAR. It preserves:

- All `dev.everframe.**` class + method + display names (componentPath
  reflection).
- All `@Composable`-annotated function names (componentPath of Compose
  call sites).
- `RuntimeVisibleAnnotations`, `Signature`, `InnerClasses`, `EnclosingMethod`,
  `SourceFile`, `LineNumberTable` (KFunction.name walks).
- kotlinx.serialization companion serializers (envelope JSON).
- The OkHttp interceptor entry surface.
- The class names of React Native views and of Flutter's host View
  (`io.flutter.embedding.android.FlutterView`), by which native video recognises windows it must
  not record. Flutter minifies release builds by default; without this rule a renamed Flutter host
  would be recorded like an ordinary view.

To verify your release APK preserves the names Everframe needs, run:

```bash
./gradlew :app:assembleRelease
APK=app/build/outputs/apk/release/app-release.apk
unzip -p "$APK" classes.dex | strings -a | grep -E 'dev.everframe.Everframe'
```

If you see matches, R8 reflection survival is intact. The CI release-minified
APK string-survival gate (`.github/workflows/android.yml`) runs this against
the Compose sample app on every PR.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Network panel is empty in submitted reports | Customer's OkHttpClient skipped `addEverframeInterceptor()` | Add the interceptor to every customer-built OkHttp client; the SDK does NOT install a global default interceptor. |
| Shake gesture never fires | The dashboard or local SDK option is disabled, the app is backgrounded, or the device has no accelerometer. | Enable Shake to report in the app dashboard and keep `shakeToReportEnabled = true`. Android TV is intentionally unsupported. |
| Reporter never opens on Android TV | The SDK no longer installs a TV key-combo handler (Phase 05.1). | Override `Activity.dispatchKeyEvent` and run a host-owned debouncer; see the [Triggers are host-app concern](#triggers-are-host-app-concern) section and `examples/android-compose/app/src/tv/kotlin/com/example/composesample/tv/SampleTVDebouncer.kt`. |
| Reserved-key configuration error at `start()` | n/a after Phase 05.1 — the SDK no longer validates trigger keys. | Per-host responsibility: never bind `KEYCODE_BACK / HOME / MENU / single-press KEYCODE_MEDIA_PLAY_PAUSE` as triggers (Play Store reject defense). |
| `IllegalStateException: Reporter UI module not on classpath` | `:everframe-reporter-ui` not in the dependency graph | Add `implementation("dev.everframe:reporter-ui:0.10.0")` — it auto-registers a startup `Initializer` that wires the resolver. |
| Customer's R8 fails with `Missing class timber.log.**` or `com.google.errorprone.annotations.**` | Customer build excludes consumer-rules from a transitive AAR | The `-dontwarn` rules ship in `:everframe-core/consumer-rules.pro`. Re-merge or copy them into your own `proguard-rules.pro`. |

---

## Limitations

- **Network capture is OkHttp-only.** Apps using HttpURLConnection / Retrofit-on-other-clients
  must build an OkHttpClient with `addEverframeInterceptor()`.
- **Foreground-only retry.** The outbox drains when the SDK's process is foreground; we do
  not register a `WorkManager` worker. Background retry is a v1.3 deliverable.
- **No Wear OS support.** Wear-style minimal trigger surface is on the v1.3 roadmap.
- **Central Portal publishing is intentionally explicit.** From the repository
  root, maintainers run `pnpm build:mobile-maven-bundle` with `SIGNING_KEY` and
  `SIGNING_PASSWORD` set. That command builds and verifies one signed ZIP with
  all Android and KMP artifacts at the version in `gradle.properties`.
  Upload that ZIP through Sonatype's direct Publisher API in `USER_MANAGED`
  mode. The release build does not use the retired OSSRH staging API.

---

## Privacy

The SDK asks for no runtime permissions. `core`'s manifest declares one install-time
permission, `android.permission.INTERNET`, which Gradle's manifest merger adds to
your app; the other modules declare none.
Sensitive UI is redacted at bake time (PRIV-03): pixels in
`Modifier.txSensitive()` / `TXSensitiveView` / `inputType="textPassword"` regions
are baked BLACK before the screenshot bytes ever reach the reporter UI or the
network. Once baked, overlays are not separable from pixels.

Authentication headers (`Authorization`, `Cookie`, `X-Api-Key`, etc.) are
filtered from captured network rows. The redaction patterns are sourced from
`assets/everframe/sensitive-headers.json` and `assets/everframe/redaction-patterns.json`,
both of which are kept in lockstep with `packages/protocol/data/` via a Gradle
`copyProtocolData` task.

---

## License

MIT. See top-level `LICENSE`.

### Native video privacy boundaries

Each native video frame is checked against the window's view tree before it is drawn, after the
copy is committed and again when the copy returns. The frame is either recorded with sensitive
areas painted black, or refused (not recorded) when the SDK cannot prove where those areas are
drawn.

**Painted black.** Views marked with `Everframe.markSensitive`, `TXSensitiveView` or the
`R.id.tx_sensitive` tag (any value except `false`), React Native `<EverframeSensitive>`, `EditText`s,
editable or password `TextView`s, and `TextureView`s are painted black over their bounds, mapped
through every ancestor's transform and scroll and padded by a pixel. A platform adapter's
`VideoPrivacyAdapter.Classification.EXCLUDE` means the same. A view whose parent clips children
confines its whole subtree to its own bounds, so that subtree is not inspected. Where parents do not
clip children (React Native views never do), the masked view's descendants are inspected too, down
to those confined that way: the part of a descendant's bounds outside the masked view is painted as
well, so a child laid out or moved outside the view stays covered, and a descendant whose position
cannot be proven refuses the frame (see below). Masks are clipped to the window. Only these views
are masked: content that repeats a secret elsewhere, such as one-time-code digit cells, a card
preview or a search echo, needs its own marker. Copies that other code draws are not covered either:
a snapshot of a view drawn in a transition overlay, a view drawn after it was removed from the
window (a container transform still draws a container the app removed instead of hiding), or a
container that a transition or container transform draws elsewhere while it sits inside a masked
view. Such a container is not evaluated on its own, whether it is `GONE` or not, so frames are
recorded with only the outer mask unless a descendant check below refuses them. Mark the container
itself with `Everframe.markSensitive` (`TXSensitiveView` and `<EverframeSensitive>` call it), which
tracks it (see below) so that it is evaluated on its own: native video ignores a bare
`R.id.tx_sensitive` tag on a view inside another masked view.

**SurfaceViews.** A `SurfaceView` renders into its own surface, which a window copy never contains.
Its area is left empty without a mask, and views drawn above it, such as subtitles and player
controls, are recorded.

**Refused frames.** No frame is recorded while:

- a WebView is visible (see the exception below), or the window shows Compose or Flutter content.
  Compose can walk thousands of nonsemantic layout nodes while computing a public semantics child
  list, exceeding the SDK's 2,048-node / 2 ms admission budget; a typed semantics prototype is
  retained only in shared test sources. Flutter pixels are recorded only through the Flutter
  plugin's masked Dart replay. Screenshot handling is unchanged.
- a view cannot be classified, a React Native view appears without the platform adapter, or the
  adapter answers `UNKNOWN`.
- the drawn position of a masked view the walk reaches (in the window's child tree and not inside
  another masked view), or of a tracked one (see below), cannot be proven: it or an ancestor sits in
  an overlay or under a broken parent chain; a legacy `Animation` or an animation matrix applies to
  it or an ancestor (an `Animation` kept with `fillAfter` keeps refusing frames until
  `clearAnimation()`); a layout transition is running above it; it or an ancestor is `INVISIBLE`,
  has transition alpha below one, or is fully transparent (alpha 0) even while `GONE`, because then
  only another drawing can show it (a shared-element ghost draws a hidden original from an overlay,
  and a container transform makes both containers transparent, the closing one usually also `GONE`,
  while it draws them from an overlay with `View.draw`, which ignores visibility); or it is `GONE`
  while a removal transition still draws it. Otherwise a `GONE` ordinary child needs no mask. This
  refuses frames while an inline `NumberPicker` (including spinner-mode date and time pickers) is
  shown after its first touch, which hides its input as `INVISIBLE`; while a React Native
  `TextInput` is hidden with `display: 'none'` or styled with `opacity: 0`, as one-time-code fields
  often are; and for as long as a container faded to alpha 0 and then set `GONE` holds such a masked
  view. Restore such a container's alpha once it is hidden, or remove it.
- an inspected descendant of a masked view (see above) is animated, `INVISIBLE` or
  transition-hidden, or runs a layout transition, for the same reasons. React Native hides
  `display: 'none'` content and the spinner of `<ActivityIndicator animating={false}>` as
  `INVISIBLE`: inside `<EverframeSensitive>` they refuse frames for as long as they stay mounted, so
  unmount hidden content instead.
- the keyboard pans the window (`adjustPan`) and the frame needs masks: the panned window is drawn
  shifted, so the masks would miss the views they cover.
- the window is `FLAG_SECURE`, wide-gamut or HDR, or unfocused, the 2,048-node / 2 ms budget runs
  out, or sensitive-view tracking is uncertain or full.

A masked area that moves on screen while a copy is pending, for example while a list scrolls, drops
that frame too. Masked areas that stay still or move entirely outside the window do not, and neither
does a descendant moving within its masked ancestor's bounds, such as a pulsing indicator.

Mark sensitive overlay content **before attachment** with `Everframe.markSensitive`
(`TXSensitiveView` and `<EverframeSensitive>` call it), for example
`Everframe.markSensitive(overlayView)` before `container.overlay.add(overlayView)`. Android's public
View child traversal cannot enumerate views inserted directly into an overlay. An input that was
never observed in the normal child tree therefore requires this marker; a bare `R.id.tx_sensitive`
tag, or an unmarked input, on a view added straight to an overlay is never tracked and is recorded
unmasked. The SDK retains bounded weak tracking for views marked with `Everframe.markSensitive` and
previously observed sensitive Views until they detach: one retained by a removal transition stays
masked, and one moved into an overlay, directly or with a container (as a fade-out transition does),
refuses its window's frames. Tracking uncertainty or capacity exhaustion excludes video.

Automatically detected WebViews are an exception: an attached background WebView does not block
replay when its ordinary child ancestry proves it `GONE`, fully transparent, or fully clipped in a
hierarchy that clips children. That proof also accepts a WebView whose container a container
transform has made transparent while drawing it from an overlay, so mark a WebView in such a
container sensitive. Nearly transparent and partially visible WebViews remain excluded.
`INVISIBLE` ancestors and non-default transition alpha remain excluded: transitions can draw an
overlay ghost while hiding the original. Removal-transition children that retain a parent without
normal child membership are also excluded. Legacy animations, animation matrices, running layout
transitions, uninspectable overlay ancestry, and exhausted inspection budgets remain excluded.
Visibility is rechecked during frame capture and in weak history, so hiding a previously visible
WebView can resume recording without unmounting it. Initially hidden WebViews are tracked too, to
protect later moves into overlays. Explicit markers and platform-adapter exclusions take precedence
over this exception: a marked WebView is painted black like any other marked view.

For React Native Android first paint, use `<EverframeSensitive>`: its native host constructor marks
the existing wrapper node before mounting. The imperative `useEverframeSensitiveRef` hook runs
after mounting and cannot protect first paint. Unresolved imperative native registrations block
video until confirmed native tagging. If an RN instance is invalidated with unresolved or pending
registrations, a single process-wide uncertainty token keeps video disabled until process restart:
module invalidation alone does not prove that its native views detached. Normal reporting continues.
