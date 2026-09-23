<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe for Android (v1.2)

Native Android SDK for Everframe — in-app bug reporting with annotated screenshots,
session replay, log/network ring buffers, and a built-in Compose reporter UI.
Covers phone, tablet, and Android TV.

> **Status:** Phase 5 (Plans 01–08) complete. Maven artifacts published to
> [GitHub Packages](https://github.com/scriptx-com/everframe/packages). Public Maven
> Central is deferred to v1.3.

---

## Maven coordinates

| Module                       | Purpose                                                                      | Required? |
| ---------------------------- | ---------------------------------------------------------------------------- | --------- |
| `dev.everframe:core` | SDK kernel: capture, envelope, transport, outbox, OkHttp interceptor         | yes       |
| `dev.everframe:protocol` | quicktype-generated kotlinx-serialization data classes for `ReportEnvelope` | transitively via `-core` |
| `dev.everframe:reporter-ui` | Compose Material 3 reporter UI for phone + tablet (bubble, modal, annotation) | yes for in-app reporting |
| `dev.everframe:everframe-tv`   | Compose-for-TV reporter Activity for Android TV                              | only if you ship to Android TV |
| `dev.everframe:everframe-gradle-plugin` | OPTIONAL — extra R8 keep rules + Compose displayName preservation       | optional |

All modules ship under the same version (currently `1.2.0`). Bump in lockstep.

---

## Quick start

### 1. Authenticate to GitHub Packages

GitHub Packages requires a fine-grained Personal Access Token (PAT) with
`read:packages` scope. Create one at
<https://github.com/settings/tokens> and store it locally:

```properties
# ~/.gradle/gradle.properties
gpr.user=<your-github-username>
gpr.token=<your-pat-with-read:packages>
```

For CI, the standard recipe is to consume `GITHUB_ACTOR` and `GITHUB_TOKEN`
environment variables (already set inside GitHub Actions runners; for other
CI systems, set them manually):

```yaml
- name: Build with Everframe
  env:
    GITHUB_ACTOR: ${{ github.actor }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: ./gradlew assembleRelease
```

### 2. Add the repository

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
        maven {
            url = uri("https://maven.pkg.github.com/scriptx-com/everframe")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: providers.gradleProperty("gpr.user").orNull
                password = System.getenv("GITHUB_TOKEN") ?: providers.gradleProperty("gpr.token").orNull
            }
        }
    }
}
```

### 3. Add dependencies

```kotlin
// app/build.gradle.kts
dependencies {
    implementation("dev.everframe:core:1.2.0")
    implementation("dev.everframe:reporter-ui:1.2.0")

    // Only if your app ships to Android TV
    "tvImplementation"("dev.everframe:everframe-tv:1.2.0")
}
```

### 4. Initialize at startup

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Everframe.start(
            this,
            EverframeConfig(
                appId = "your-app-id",
                endpoint = "https://ingest.your-tenant.example/api/ingest",
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

`r8MappingId` is optional and must match
`[A-Za-z0-9][A-Za-z0-9._-]{0,127}` exactly. Treat it as immutable build
identity and upload the matching mapping only from trusted CI.

---

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
    id("dev.everframe") version "1.2.0"
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
| `IllegalStateException: Reporter UI module not on classpath` | `:everframe-reporter-ui` not in the dependency graph | Add `implementation("dev.everframe:reporter-ui:1.2.0")` — it auto-registers a startup `Initializer` that wires the resolver. |
| Customer's R8 fails with `Missing class timber.log.**` or `com.google.errorprone.annotations.**` | Customer build excludes consumer-rules from a transitive AAR | The `-dontwarn` rules ship in `:everframe-core/consumer-rules.pro`. Re-merge or copy them into your own `proguard-rules.pro`. |

---

## Limitations (v0.9)

- **Network capture is OkHttp-only.** Apps using HttpURLConnection / Retrofit-on-other-clients
  must build an OkHttpClient with `addEverframeInterceptor()`.
- **Foreground-only retry.** The outbox drains when the SDK's process is foreground; we do
  not register a `WorkManager` worker. Background retry is a v1.3 deliverable.
- **No Wear OS support.** Wear-style minimal trigger surface is on the v1.3 roadmap.
- **Central Portal publishing is intentionally explicit.** Maintainers create a
  signed Maven-layout bundle with `./gradlew centralPortalBundle
  -PeverframeVersion=0.9.0`, validate it with
  `scripts/verify-central-bundle.sh`, then upload that bundle through Sonatype's
  direct Publisher API in `USER_MANAGED` mode. This build does not use or retain
  the retired OSSRH staging API.

---

## Privacy

By default the SDK captures no permissions. The published AAR has `0` `<uses-permission>`
entries (CI gate enforced — `aapt dump permissions everframe-core-release.aar`).
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

Native video currently excludes Compose windows. A typed semantics prototype is retained only
in shared test sources: Compose can walk thousands of nonsemantic layout nodes while computing
a public semantics child list, exceeding the SDK's 2,048-node / 2 ms admission budget. Screenshot
semantics handling is unchanged.

Mark sensitive overlay content **before attachment**, for example
`Everframe.markSensitive(overlayView)` before `container.overlay.add(overlayView)`. Android's public
View child traversal cannot enumerate views inserted directly into an overlay. An input that was
never observed in the normal child tree therefore requires this explicit marker. The SDK retains
bounded weak tracking for explicitly marked and previously observed sensitive Views, including
Views moved into overlays or retained by removal transitions. Explicit sensitivity and unsupported
inputs/surfaces continue excluding their window until detachment. Tracking uncertainty or capacity
exhaustion excludes video.

Automatically detected WebViews are an exception: an attached background WebView does not block
replay when its ordinary child ancestry proves it `GONE`, fully transparent, or fully clipped in a
hierarchy that clips children. Nearly transparent and partially visible WebViews remain excluded.
`INVISIBLE` ancestors and non-default transition alpha remain excluded: transitions can draw an
overlay ghost while hiding the original. Removal-transition children that retain a parent without
normal child membership are also excluded. Legacy animations, animation matrices, running layout
transitions, uninspectable overlay ancestry, and exhausted inspection budgets remain excluded.
Visibility is rechecked during frame capture and in weak history, so hiding a previously visible
WebView can resume recording without unmounting it. Initially hidden WebViews are tracked too, to
protect later moves into overlays. Explicit markers and platform-adapter exclusions take precedence
over this exception. This does not add WebView or text-input masking; visible login inputs still
exclude native video.

For React Native Android first paint, use `<EverframeSensitive>`: its native host constructor marks
the existing wrapper node before mounting. The imperative `useEverframeSensitiveRef` hook runs
after mounting and cannot protect first paint. Unresolved imperative native registrations block
video until confirmed native tagging. If an RN instance is invalidated with unresolved or pending
registrations, a single process-wide uncertainty token keeps video disabled until process restart:
module invalidation alone does not prove that its native views detached. Normal reporting continues.
