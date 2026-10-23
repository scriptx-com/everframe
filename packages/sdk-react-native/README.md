<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/react-native

Everframe React Native bridge — exposes the native iOS and Android reporter
modal to RN host apps via a TurboModule + a thin React provider/hook API.

> Phone, Apple TV, and Android TV are all supported when the host app is
> built against `react-native-tvos` (see [TV Host Integration](#tv-host-integration-apple-tv--android-tv)).

---

See the [crash-reporting support matrix](../../docs/crash-reporting-support.md)
for exact tested paths, unsupported combinations and remaining qualification.

## Installation

```bash
pnpm add @everframe/react-native
```

Peer dependencies: `react` ≥ 19, `react-native` (or `react-native-tvos` for
TV targets) ≥ 0.85.

Then install pods (iOS) / sync Gradle (Android) as usual:

```bash
cd ios && pod install
```

### Source maps and symbols

Release builds can upload their Hermes source maps, dSYMs, R8 mappings and
native libraries, so crashes show your code. Wrap Metro with
`withEverframe` from `@everframe/metro`, add `@everframe/cli`, and set up the
native projects once. In Expo, apply `withEverframe` from `@everframe/expo`
with your App ID in `app.config.js`. In a bare app, run:

```bash
npx @everframe/cli setup react-native --app-id "$EVERFRAME_APP_ID"
```

Either way, Android gets `apply plugin: "dev.everframe"` and
`everframe { appId = "…" }` plus one classpath line, and Xcode gets a
one-line Run Script phase that runs `scripts/xcode-upload.sh` from the installed
`@everframe/cli`. The upload logic lives in the Gradle plugin and the CLI. Set `EVERFRAME_API_TOKEN` in release builds;
without it the build warns and continues. See the
[CLI guide](../cli/README.md#react-native-and-expo).

## React Native Web

`@everframe/react-native` has a browser entry and an explicit
`@everframe/react-native/web` entry. Both re-export the existing
`@everframe/react` package, which is installed as a dependency. Your app
imports from `@everframe/react-native` on every platform:

```sh
pnpm add @everframe/react-native
```

React Native Web hosts also need React DOM, as usual. The browser entry uses
the React web reporter, DOM screenshot, and rrweb replay. It does not load the
native TurboModule. `EverframeSensitive` is an alias of
the React SDK's `Sensitive` component on web, so shared app code can keep the
same import. `useEverframeSensitiveRef` also registers a browser element with
the web mask registry. Native iOS and Android use their native capture. A web
bundler that honors the `browser` export condition can keep the regular package
import; use the `/web` subpath if its resolver does not select that condition.

Replays also attach to errors; see [session replay](../../docs/session-replay.md).

## Usage

Wrap your app with `<EverframeProvider>` at the highest practical level
(above any navigator / focus engine root):

```tsx
import { EverframeProvider, useEverframe } from '@everframe/react-native';

export default function App() {
  return (
    // `sdkKey` is the only required field. The ingest endpoint is a
    // compile-time constant in the SDK and is not configurable in v1.
    <EverframeProvider
      config={{
        sdkKey: 'evf_live_xxxxxxxxxxxxxxxx',
        // Recommended in RN/Expo development: shake also opens the dev menu.
        shakeToReport: { enabled: !__DEV__ },
      }}
    >
      <RootNavigator />
    </EverframeProvider>
  );
}
```

Trigger the reporter from any host UI:

```tsx
function HelpButton() {
  const { open } = useEverframe();
  return <Button title="Report a bug" onPress={() => open()} />;
}
```

For non-component contexts, use the top-level `open` re-export
(throws `EverframeNotMountedError` if the provider is not yet mounted):

```ts
import { open } from '@everframe/react-native';
await open();
```

`open()` returns a `ReporterResult` with `{ status: 'submitted' |
'queued' | 'cancelled', ... }`.

For handled JavaScript exceptions, call `captureException(error)` from the
provider context and attach any non-sensitive context needed for diagnosis.
The source API requires matching rebuilt native components; published `0.7.0`
artifacts are not evidence of support.

## Release health

Release health counts crash-free foreground sessions for each version of your
app. It is on by default, and debug builds of the native app aren't counted.
Turn it off in the `EverframeProvider` config:

```tsx
releaseHealth: { enabled: false },
```

Sessions come from the Android and iOS SDKs and count toward the native app
version, which an over-the-air update doesn't change. Release health needs the
Hermes bundle identity that `@everframe/metro` adds at build time (or the
`jsBundle` option); without it, release health stays off and the SDK logs an
`[everframe]` warning (in development builds only, unless you set
`releaseHealth`). Add `userId: accountId` to count crash-free users, and
`includeDebugBuilds: true` to count debug builds too. The configuration is read
when the Provider mounts, so remount it with a changed `key` to change `enabled`
or `userId`. A configure with `enabled: false` turns release health off and
erases its queued records on the device.
Release health skips a debug build, which is `__DEV__` unless you set
`debugBuild` on the Provider. See
[release health](../../docs/release-health.md).

## Promise rejection observation

Automatic Hermes rejection observation is opt-in:

```tsx
import { EverframeProvider, getPromiseRejectionStatus } from '@everframe/react-native';

<EverframeProvider config={{
  sdkKey: '…',
  crashReporting: { promiseRejections: { enabled: true } },
}}>
  <App />
</EverframeProvider>

// Read after mount. This reports observer coverage, not delivery confirmation.
const status = getPromiseRejectionStatus();
```

The verified runtime is Android/iOS `react-native-tvos@0.85.3-0` with Hermes
release `250829098.0.10`, Release/Static Hermes and bytecode 98. Qualification
uses optimized apps on an Android API 35 arm64 emulator and an iOS 26.5 arm64
simulator with Debug/local native SDK transport, including expiry after the app
process is suspended, source mapping and encrypted retry after relaunch.
Physical devices, device sleep and production transport are not qualified by
these checks. Matching the SDK's broader RN peer range does not establish
rejection support. Other versions, JSC, browser execution, tvOS,
unverified Promise replacements and incompatible hooks return `unsupported`.
The adapter checks runtime identity and a fulfilled-only hook handshake; it
does not generate a test rejection or replace the Promise constructor.

Rejections still unhandled after 2 seconds enter the existing nonfatal capture
path. A handler attached within that interval cancels capture; later handling
does not retract an accepted report. The notification uses a JavaScript timer.
Android pauses JavaScript timers while the app's activity is paused (in the
background, behind another activity or in picture-in-picture), although
JavaScript can keep running. Rejections observed then are notified on later
Promise activity or when the activity resumes. Explicit capture and automatic
reporting share accepted error identity, and automatic reports retain their
existing 10-distinct-key allowance per mount. Automatic reports are
deduplicated by exception type and top stack frame. Non-Error reasons have no
stack and are deduplicated by their reported value with digit runs ignored, so
`Request 1001 failed` repeats `Request 1000 failed` and all object reasons
share one report per mount. They spend at most 5 of the 10 keys, so values that
differ in other ways, such as hex identifiers, still leave 5 keys for `Error`
rejections and other automatic reports.

The observer retains at most 16 detached snapshots, each at most 64 KiB of
serialized UTF-8 data. It drops new arrivals when full and oversize snapshots
rather than retaining arbitrary error graphs. Work is counted as expired
instead of reported when it is notified more than 30 seconds after the
rejection. Age is measured on the platform's elapsed clock and bounded by
wall-clock time, which keeps advancing while an Android device sleeps. Cleanup
cannot run while JavaScript is suspended, so stale work expires when
JavaScript resumes. Error facts and causes are snapshotted at rejection time.
Rejection reasons that are not `Error` objects are reported as `UnhandledValue`
without a stack or cause chain, even when they carry a `cause`. Strings,
numbers, booleans, `null` and `undefined` keep their bounded value; objects,
arrays, functions, symbols and bigints are reported only as a type label such
as `[object]` rather than serialized.
Native context and breadcrumbs are collected at notification time. A preserved
external tracker may independently retain errors or generate its own reports.

`getPromiseRejectionStatus()` returns `disabled`, `unsupported`, `observing`,
`displaced`, `install-failed`, or `not-mounted`, with a reason and bounded
counters for pending, accepted, cancelled, dropped, expired, suppressed,
refused, failed and discarded captures. A rejection handled within the 2-second interval counts as cancelled,
even if it was dropped or failed to snapshot on arrival. Counters saturate at
2,147,483,647 and reset on each mount; they contain no captured messages or
stacks. Replacing either hook stops this observer until a new mount and
releases its pending work, counted as `discarded`.
`crashReporting.disabled: true` overrides the opt-in, and unmount discards
pending work. Configuration changes take effect on a new mount.
The browser export reports Hermes observation as unsupported and preserves the
browser SDK's own error handling.

## Error capture and diagnostics

### Native crashes and ANRs

Crash reporting also turns on the native SDKs' automatic crash capture. On Android that covers JVM exceptions, native crashes (OS exit records on API 30+, with tombstone frames on API 31+) and ANRs on API 30+; see the [Android SDK guide](../sdk-android/README.md#crash-capture-on-by-default). On iOS it is the native crash recorder. `crashReporting: { disabled: true }` turns all of it off on both platforms.

### Errors no boundary catches

Since React Native 0.78, React reports an error that no error boundary catches
(thrown while rendering, in an effect or in a lifecycle method) through the
root's `onUncaughtError`. That calls React Native's `ExceptionsManager`, never
the `ErrorUtils` handler. Crash reporting hooks
`ExceptionsManager.handleException` too, so such an error is reported as a fatal
JavaScript crash (`mechanism: "errorutils"`) with its Hermes stack, and React's
component stack follows the message after `This error is located at:`, as in
React Native's own report. React unmounts the whole tree, `EverframeProvider`
included, before it reports the error; the hook stays until the end of that
task, so the error is still captured. The native fatal React Native raises for
the same error (`RCTFatalException` on iOS and tvOS, `JavascriptException` on
Android) is not reported a second time. An error in the render that first
mounts the provider comes before this capture is installed. Errors a boundary
catches are not reported automatically; use the callback below.

### React error boundary callback

An existing React class boundary can opt into handled capture. Render the
boundary inside `EverframeProvider`:

```tsx
import * as React from 'react';
import { EverframeProvider } from '@everframe/react-native';
import { captureReactError } from '@everframe/react-native/integrations/react';

class Boundary extends React.Component<React.PropsWithChildren, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    captureReactError(error, info);
  }
  render() { return this.state.failed ? null : this.props.children; }
}

export default function App() {
  return (
    <EverframeProvider config={{ sdkKey: '…' }}>
      <Boundary>
        <RootNavigator />
      </Boundary>
    </EverframeProvider>
  );
}
```

A boundary that wraps `EverframeProvider` does not report through it: its
fallback replaces the provider in the same commit, before `componentDidCatch`
runs. Such a boundary reports only if its fallback renders its own
`EverframeProvider`, which mounts before `componentDidCatch` runs. Errors that a
boundary inside the provider catches during the provider's first commit (the
initial render that also mounts the provider) are not captured, and they are
not replayed. Disabled crash reporting and calls after unmount are also inert.
In development builds, a call that finds no mounted provider logs a warning, at
most once until a provider mounts or unmounts.

The application owns fallback and recovery UI. This callback reports caught
component errors; it does not install global renderer hooks or capture arbitrary
async/event-handler errors. Component-stack metadata is bounded and redacted by
the existing capture pipeline, without replacing exception frames or cause data.

The original error shares accepted identity with manual and nonfatal automatic
capture within a mount. Native refusal permits recapture; equal fingerprint keys
can also suppress distinct objects. A later fatal escalation may report separately.
The adapter subpath is unavailable to browser-conditioned consumers.

### Local capture admission diagnostics

```ts
import { getErrorCaptureStatus } from '@everframe/react-native';
const status = getErrorCaptureStatus();
const { attempted, accepted, duplicateSuppressed } = status.counters.handled;
```

Snapshots are detached, contain no captured content, reset on remount, and perform
no native query or upload. Paths are `handled` (including the boundary callback),
`errorUtils` (including errors no boundary catches), and `rejection` (submission only). Each active attempt has one outcome:
`accepted`, `duplicateSuppressed`, `allowanceSuppressed`, `bridgeUnavailable`,
`nativeRefused`, `captureFailed`, `reentrantSuppressed`, or `inactiveAborted`.
Counters saturate at 2,147,483,647. Existing limits are ten
handled and ten automatic distinct keys; fatal capture bypasses them.

`accepted` requires exactly true from the native capture method. It does
not mean upload success, server processing or outbox removal. This snapshot excludes native queue and
delivery observations; read those with `getReportDeliveryStatus()`. Status is
neutral `not-mounted` without a provider, `disabled` under the crash-reporting
veto, and `unsupported` on the browser root entry.

Installed boundary qualification passes on Android API 35 arm64 emulator and
iOS 26.5 arm64 simulator for this exact phone-host row:
React 19.2.5, `react-native-tvos` 0.85.3-0 aliased as `react-native`, Expo
56.0.0-preview.7, Hermes 250829098.0.10 / bytecode 98. Other RN distributions,
versions, TV, physical devices and production endpoints are not qualified by
this matrix. Installed checks cover four genuine boundary capture cases,
disabled/initial zero controls, mapped causes, and byte-identical encrypted retry
after relaunch. The application/JS builds are optimized; native SDKs are
Debug/local. Physical-device and production-endpoint qualification remains open.

### Native report delivery diagnostics

`getReportDeliveryStatus()` synchronously copies cached native observations. It
performs no file reads, uploads, drains, or hook installation. Use
`getErrorCaptureStatus()` separately for JavaScript admission decisions.

```ts
import { getReportDeliveryStatus } from '@everframe/react-native';
const status = getReportDeliveryStatus();
console.log(status.status, status.queue.observation, status.queue.pendingCount);
```

The schema separates native capture acceptance, queue operations and settled
transport attempts (`live-submit` and `outbox-drain`). `server-accepted` means an
HTTP 2xx response; it does not establish processing, symbolication, dashboard
visibility or queue removal. Removal has its own operation counter. Counters are
operations, not unique reports, and saturate at 2,147,483,647.

The queue is the SDK's shared report outbox, including reporter submissions and
entries from earlier configurations. Its count is last-observed, not a fresh
measurement or a current-project/crash-only total. Missing counts mean unknown;
`partial` means only readable entries were counted. Android rejects new entries
at capacity and retains terminal HTTP responses during drain. iOS can evict older
entries and attempts removal after terminal HTTP responses. Custom standalone
outbox/submitter instances are not automatically included.

Snapshots contain only fixed codes and counters, never report content, IDs,
URLs, credentials or exception strings. Observations are process-local and reset
on native start/reconfiguration or kill. They are best-effort: contention and
termination may lose observations; a busy getter reports `snapshot-busy`.
`bridge-handled` and `bridge-automatic` cover fact entry paths shared by framework
bridges. iOS marks `jvm-uncaught` unsupported and implies no automatic iOS native
crash collector.

Without a mounted provider the result is `not-mounted/no-mount`; the browser
export is `unsupported/platform`. A missing or throwing native call returns
`unavailable/native-call-failed`, and malformed native responses return
`unavailable/invalid-native-snapshot`. These fallbacks have an unobserved queue
and `unknown` platform policies. This API does not provide a per-report delivery
guarantee or trigger a retry.

## Network body capture (client veto)

```tsx
<EverframeProvider config={{ sdkKey: '…', networkBodies: { disabled: true } }}>
```

`networkBodies.disabled: true` is a **client veto** — it can only turn body
capture off locally; it can never turn it on. The server's per-app
`captureBodies` gate is still authoritative, and native network capture must
still be wired up on each platform (see below) before any body is ever
recorded.

**This option does not, by itself, make React Native capture network
bodies.** RN does not currently attach Everframe's network capture to its own
HTTP clients (`fetch`, Axios, etc.) — that wiring is tracked separately and
is not part of this SDK yet. RN apps do still inherit the native SDK's own
auto-capture running underneath them, so `networkBodies` controls that
native capture — and even that requires the native side to actually be
capturing network traffic in the first place:

- **Android**: bodies are captured only for OkHttpClient instances the host
  app explicitly builds with `addEverframeInterceptor()` (see
  `packages/sdk-android/android/README.md`). Without that interceptor, no
  network capture — and therefore no bodies — happens regardless of this
  option.
- **iOS**: equivalent native network capture wiring, if and when the host
  app uses it.

Do not enable this option expecting RN's own network calls to show up in
reports — that capability doesn't exist yet.

## Crash-only sessions

```tsx
<EverframeProvider config={{ sdkKey: '…', reporter: { disabled: true } }}>
```

`reporter.disabled: true` turns the bug reporter off for the session and
keeps crash and error reporting, for example in production builds. It is a
**client veto**: the dashboard can't turn the reporter back on for this
session.

In a crash-only session:

- Shake-to-report is off, and `open()` rejects with
  `EverframeReporterDisabledError`.
- Session replay uses the app's crash-only sampling rate, which is 0 by
  default. An error carries a replay only while the session records.
- Network bodies aren't captured.
- Crash and error capture, breadcrumbs, vitals, release health and the
  companion work as usual.

A companion bond (a phone scanning the QR code, or a dashboard member
attaching) upgrades the session. Replay and network bodies then follow the
app's normal settings for the rest of the session, and recording starts at
the bond. The reporter stays off: reports from an upgraded session come
through the companion. See
[crash-only sessions](../../docs/session-replay.md#crash-only-sessions).

## Navigation breadcrumbs

Mark screens with one line; the native SDK derives `from → to` from a global
chain shared with native auto-capture. Works with any navigation approach.

react-navigation (screens stay mounted — pass focus):

```tsx
import { useEverframeScreen } from '@everframe/react-native';
import { useIsFocused, useRoute } from '@react-navigation/native';

function DetailScreen() {
  useEverframeScreen(useRoute().name, { focused: useIsFocused() });
  ...
}
```

…or whole-app in one place:

```tsx
<NavigationContainer ref={navRef}
  onStateChange={() => recordScreen(navRef.getCurrentRoute()?.name ?? '')}>
```

Wix react-native-navigation:

```tsx
componentDidAppear() { recordScreen(this.props.screenName); }
```

Hand-rolled (conditional-render tabs, custom switchers):

```tsx
function DeskTab() {
  useEverframeScreen('Desk');
  ...
}
```

Screen names should be route identifiers, never user content.

## Opt-in JS integrations

Native capture (taps, screens, lifecycle, errors) is automatic. Two things
live only in JS — console logs and navigator state — and are captured ONLY
when you opt in:

```tsx
import { consoleIntegration } from '@everframe/react-native/integrations/console';
import { reactNavigationIntegration } from '@everframe/react-native/integrations/react-navigation';
import { createNavigationContainerRef } from '@react-navigation/native';

const navigationRef = createNavigationContainerRef();
const txNav = reactNavigationIntegration({ navigationRef });

<EverframeProvider config={{ sdkKey, integrations: [consoleIntegration(), txNav] }}>
  <NavigationContainer ref={navigationRef} onReady={txNav.onReady}>
    ...
```

- `consoleIntegration({ levels? })` — forwards `console.log/info/warn/error`
  (configurable) to the breadcrumb trail with real severity. Originals always
  run first.
- `reactNavigationIntegration({ navigationRef })` — records every route
  change via `recordScreen`; also covers expo-router. Pass `txNav.onReady`
  to the container so the initial route is recorded.

Using another navigator? Any stack is a ~5-line adapter over
`recordScreen` — the `useEverframeScreen` recipes above cover Wix RNN and
hand-rolled navigation, and a custom integration is just
`{ name, setup() { ...subscribe...; return unsubscribe } }`.

## Session Vitals

Native capture again: every RN app automatically gets background CPU/memory
sampling and a session id stamped on reports and crashes as soon as the host
app's project has vitals enabled on the dashboard — no JS change required.

What JS adds is **player tracking**, because in RN the player instance lives
inside a native view and never reaches JS.

### Config

```tsx
<EverframeProvider config={{ sdkKey, vitals: { enabled: true, sampleRate: 0.5, captureSourceQuery: false } }}>
```

- `enabled` — absent follows the dashboard toggle; `false` opts out locally;
  `true` never forces vitals on if the dashboard has them off.
- `sampleRate` — `[0, 1]`, `min()`'d with the server-configured rate.
- `captureSourceQuery` — keep the query string on `source_change.src`
  (default `false`: signed CDN URLs carry tokens in the query).

**Reconfiguring.** A Provider remount with the _same_ config does not restart
the SDK: both native sides compare the incoming config against the _installed_
one and skip the start entirely. A **changed** config does restart it (on iOS,
except a change confined to `releaseHealth` or the loaded bundle; see
[Release health](#release-health)) — and a
start supersedes the running SDK, detaching every player integration it had
announced. **Limitation:** players tracked before that restart stay untracked
until their screens remount; nothing re-registers them automatically. Two React
instances in one process are _not_ coordinated either: if a second one starts
the SDK under the first, the first instance's players stay untracked until its
own screens remount.

### react-native-video (v7)

```tsx
import { useVideoPlayer, VideoView } from 'react-native-video';
import { useVideoPlayerVitals } from '@everframe/react-native/integrations/react-native-video';

function Player() {
  const player = useVideoPlayer(source);
  useVideoPlayerVitals(player, { name: 'main', libraryVersion: '7.0.0' });
  return <VideoView player={player} />;
}
```

`libraryVersion` is a host-supplied option — react-native-video does not
expose it at runtime.

**To measure INITIAL startup, defer the load:**

```tsx
// Module scope: the latch belongs to the PLAYER, not to the component. A
// replacement instance (StrictMode's double-mount, a source change) is a
// different object and gets its own initialize; the same instance never
// gets a second one, which would restart playback under the user.
const initialised = new WeakSet<object>();

const player = useVideoPlayer({ uri: SOURCE, initializeOnCreation: false });
useVideoPlayerVitals(player, { name: 'main', libraryVersion: '7.0.0' });

useEffect(() => {
  if (initialised.has(player)) return;
  initialised.add(player);
  void player.initialize();
}, [player]);
```

Why: on Android react-native-video v7 emits `onLoadStart` synchronously from
inside the native player constructor — before any effect runs, so before the
adapter has subscribed — and `onLoadStart` is what arms the adapter's startup
clock, so the first source's startup latency is simply never seen. Deferring
the load until after the adapter subscribed puts the first `onLoadStart` back
where it can be observed. Without this, everything else still works; only the
_first_ `startup` measurement is missing (later source changes are fine).

Options: `name`, `libraryVersion`, and `captureErrors` (default `false` — see
Limitations). `onBandwidthUpdate` is read per platform: on iOS its `bitrate`
is the rendition's declared bitrate and drives `bitrate_change` plus the
`bitrate` stat; on Android it is ExoPlayer's bandwidth estimate, reported as
the `bandwidthEstimate` stat (with `quality_change` for the accompanying
rendition size) and never as a bitrate.

`onProgress` is read per platform too. The `bufferAheadMs` stat is always the
media time buffered _ahead of the playhead_: on Android `bufferDuration` is
already that, on iOS it is the buffered range's absolute end position, so the
adapter subtracts `currentTime` from it.

### THEOplayer

```tsx
import { attachTheoPlayerVitals } from '@everframe/react-native/integrations/theoplayer';

<THEOplayerView onPlayerReady={(player) => attachTheoPlayerVitals(player, { name: 'main' })} />
```

Both adapters are pure translators: neither library is imported at runtime
or added as a dependency of this package.

### Custom log lines

```ts
import { trackVitals } from '@everframe/react-native';

trackVitals('ad_break', { pod: 1 });
```

### Any other player: `trackPlayer`

Libraries without an adapter above (or a player object outside a component
tree) can drive the same pipeline directly:

```ts
import { trackPlayer } from '@everframe/react-native';

const handle = trackPlayer({ library: 'my-player', libraryVersion: '1.2.0', name: 'main' });
handle.emit('play');
handle.emit('buffer_start');
handle.emit('buffer_end', { durationMs: 800 });
handle.updateStats({ bufferAheadMs: 4200, bitrate: 2_500_000 });
handle.track('ad_break', { pod: 1 });
handle.detach();
```

`useTrackPlayer(opts)` is the hook form — tracks on mount, detaches on
unmount, mints a fresh token on remount (Fast Refresh-safe).

Event vocabulary for `emit`: `source_change`, `drm`, `startup`, `play`,
`pause`, `buffer_start`, `buffer_end`, `seek`, `rate_change`,
`bitrate_change`, `quality_change`, `dropped_frames`, `error`, `stats`.
`player_attach` and `player_detach` are reserved for the native lifecycle
markers the registry emits itself — passing either to `emit` is silently
dropped, not forwarded.

### Limitations

- **JS-thread stalls pause player events.** Startup timing, span
  derivation and stats all happen in JS, so a wedged JS thread stalls the
  player's vitals while it is wedged. Native CPU/memory sampling keeps
  running regardless — it does not go through JS.
- **Dropped frames** are reported only where the underlying library exposes
  them; the vocabulary has the slot, adapters fill it when they can.
- **The ten-per-minute non-fatal error budget counts forwarding attempts,
  including ones native drops** — e.g. before vitals start, or against a
  token whose registration was refused. `PlayerHandle.emit` is void
  (fire-and-forget across the bridge), so JS cannot know whether native
  admitted an entry; an error refused over there still spends a slot.
- **`captureErrors` changes react-native-video's own behaviour, so it is
  off by default.** With it on, errors carry the library's `code`
  (`'source/invalid-uri'`, …). But v7 only throws synchronously from
  `play()` / `pause()` / `seekBy()` / `seekTo()` / `selectTextTrack()` /
  `getAvailableTextTracks()` when NO `onError` listener is registered — so
  merely subscribing makes those calls stop throwing for the whole app, and
  a host relying on `try { player.play() } catch` would silently lose its
  errors. Off by default, fatal errors are still reported (via
  `onStatusChange('error')`), just without a `code`.
- **`captureErrors` keeps swallowing after detach.** react-native-video's
  listener removal leaves an EMPTY `onError` listener set rather than no set
  at all, and the library's "throw synchronously when nobody is listening"
  check only asks whether the set exists. So once `captureErrors: true` has
  been attached even once, that player keeps suppressing the synchronous
  `play()` / `seek*()` throws for the rest of its lifetime — detaching the
  vitals adapter does not give them back. A library bug, not an adapter one;
  there is nothing to fix on our side, which is the second reason
  `captureErrors` is off by default.
- **`rate_change` was not observed from react-native-video v7 on Android** in
  our Android emulator smoke — `onPlaybackRateChange` never arrived there.
  Note that the library _does_ forward ExoPlayer's
  `onPlaybackParametersChanged`, so this is a "not seen in our smoke run"
  result, not a proven library gap; a host that changes playback speed
  explicitly may well see it. Nothing on the adapter side gates it either way.
- **react-native-video v7 does not support tvOS.** As of `7.0.0-beta.11`
  there is no tvOS podspec/target, so it cannot be used on Apple TV at all.
  Use THEOplayer, or a custom `trackPlayer`/`PlayerHandle` adapter, on Apple
  TV hosts.
- **A native react-native-video plugin** (attaching the real
  ExoPlayer/AVPlayer instance directly, for full fidelity including dropped
  frames) is a follow-up once this JS-forwarding seam has proven itself in
  the field. Every library ends on ExoPlayer/AVPlayer, but JS event
  forwarding is what works universally today.

## TV Host Integration (Apple TV + Android TV)

`@everframe/react-native` supports Apple TV + Android TV when consumed
from a host app built against `react-native-tvos`. This support is developed
against RN-tvos `0.85.3-0`, Expo SDK `56.0.0-preview.7`, and React `19.2.5`;
the canonical example app below is kept building on that matrix.

### Provider placement

`<EverframeProvider>` MUST sit ABOVE the TV focus engine's root in the
component tree. The reporter is presented imperatively by the native side
(via `TXTVReporterViewController` on iOS / `:everframe-tv` `ReporterActivity`
on Android), so React Native's focus engine never sees it — the native VC
manages focus on its own UIWindow / Activity.

```tsx
<EverframeProvider config={{ sdkKey }}>
  <NavigationContainer>{/* focus engine root */}</NavigationContainer>
</EverframeProvider>
```

### Triggers are the host app's concern

Everframe installs shake-to-report on Android and iOS phones/tablets through the
native SDKs. It is enabled by default, requires no permission, safely no-ops on
Android devices without an accelerometer, and never runs on Android TV or tvOS.
The dashboard is authoritative: local `enabled: true` cannot override a
dashboard disable.

In React Native and Expo development builds, use
`shakeToReport: { enabled: !__DEV__ }` because the React Native development
menu also uses shake. Production remains enabled by default. This only stops
shake from opening the reporter: on a real phone, a development build still
takes a quick capture on shake, and a linked phone captures in any build (see
[Quick capture on phones](#quick-capture-on-phones)).

#### Quick capture on simulators and emulators

Debug builds on an iOS simulator or Android emulator can file a report without
opening the reporter: press ⇧B in the app (outside a `TextInput`), or run
`npx @everframe/cli capture` from your terminal. iOS simulators also take the
other bindings the dashboard offers (double Shift, ⌘ combos); Android
emulators use the dashboard binding only when it is Shift plus a letter or
digit, and ⇧B otherwise. Run `npx @everframe/cli login` once so captures are attributed
to you. It stays dark until the dashboard turns the capture hotkey on for the
app. Real phones use shake instead; see
[Quick capture on phones](#quick-capture-on-phones). To opt this app out
locally (simulators, emulators and phones alike, including device linking):

```tsx
<EverframeProvider
  config={{ sdkKey: 'evf_live_xxxxxxxxxxxxxxxx', quickCapture: { enabled: false } }}
>
```

`quickCapture.enabled` defaults to `true`; a local `true` never overrides a
dashboard disable. A session started with `capture.screenshot` off ignores quick
capture.

#### Quick capture on phones

On a real iPhone, iPad, or Android phone or tablet, **shake** takes a quick
capture: the same screenshot, replay window, logs, breadcrumbs and network as
⇧B in a simulator, filed as a draft that you title on the dashboard. The native
iOS and Android SDKs do all of it; there is no JavaScript API and nothing to
add to your app. A shake captures when the device is linked, or when the build is a
debug build:

| Device                  | Shake                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Linked to you           | Quick capture, a private draft for you. Toast `Captured · <your name>`.                                |
| Linked as a team device | Quick capture, a shared draft. Toast `Captured · team device`.                                         |
| Unlinked, debug build   | Quick capture, a shared draft. Toast `Captured · <device name>`. Also answers a dashboard link window. |
| Unlinked, release build | As before: the reporter opens if `shakeToReport` allows it. Also answers a dashboard link window.      |

- **Link a phone.** On the dashboard, open **Settings → Devices → Link a
  device**, then shake the phone with the app running. A banner shows
  `Linking to Everframe · 47` with the line
  `A teammate is linking a device. If that's not you, ignore this.` Click the
  same number on the dashboard; the phone shows `Linked to <your name>`.
  Nothing links on its own: a teammate always picks the number. On iOS, if the
  Keychain refuses to store the link, the phone shows `Linking failed` instead
  and stays unlinked.
- **Team devices.** An admin can pick **Link as team device** instead. The
  phone shows `Linked as team device`, and its captures go to the shared inbox
  for whoever is on the dashboard.
- **Hand a phone over.** A linked phone keeps capturing for its owner. When
  another teammate opens **Link a device** and the phone is shaken, the capture
  is filed as usual and the banner shows a number; picking it moves the phone,
  and that capture, to the new teammate.
- **Unlinking.** Unlink a phone under **Settings → Devices**. It finds out at
  its next capture or config fetch and behaves as unlinked again. A capture
  refused this way is not filed anywhere and shows `This device was unlinked`.
  Android also shows that toast when a config fetch reports the unlink; iOS
  clears the link silently then.
- **Other toasts.** `Capture didn't upload` follows a capture whose upload was
  rejected and not queued; `Capture failed` replaces `Captured` when the
  screenshot or the evidence could not be taken.
- **Debug builds.** React Native sends `__DEV__` as the build type (override it
  with `debugBuild`), so a Metro development build on a phone counts as debug
  and a shake takes a shared capture without linking. In those builds the
  React Native development menu also opens on the same shake, on both
  platforms. To stop development builds from capturing, set
  `quickCapture: { enabled: !__DEV__ }`, which also turns linking off for them.
- **`shakeToReport` controls only the reporter.** While quick capture or device
  linking is on, the native shake detector runs whatever `shakeToReport` says,
  and `shakeToReport` decides only whether an unlinked release build opens the
  reporter. Linked and debug phones keep capturing with it off.
- **Replay.** With the dashboard's capture hotkey replay setting on, linked
  phones (any build) and debug builds record session replay while quick capture
  is armed, as simulators do.
- **End users see no change.** An unlinked release build never takes a quick
  capture and never records replay because of it. The only new thing it can
  show is the matching-number banner, if someone shakes it while a teammate has
  a link window open.
- **Off switches.** The dashboard's per-app **Device linking** switch stops
  phones from asking to link. The dashboard's capture hotkey switch,
  `quickCapture: { enabled: false }` or `reporter: { disabled: true }` turn off
  quick capture and linking together, and shake then behaves as before.
- **The token.** The device token is kept in the iOS Keychain, or encrypted
  under an AndroidKeyStore key on Android. It is bound to the ingest endpoint
  and SDK key that linked it, sent only there, and never logged. A linked
  capture queued offline is sent later only while the same link is still
  stored; otherwise it is dropped, never filed into another inbox.
- **Platform differences.** On Android, one long shake can fire the detector
  more than once, so a shake within 2 seconds of a capture is ignored. Phones
  and tablets are covered on both platforms. Apple TV behaves as before;
  Android TV uses a remote gesture instead (below). The Android behavior ships
  with the native Android SDK release that includes it.

#### Quick capture on Android TV

On Android TV the native Android SDK takes the same quick capture from a
remote gesture that the dashboard sets per app. The default is **holding
Play/Pause for 1.5 seconds**. Link the TV like a phone: open **Link a device**
on the dashboard, do the gesture on the TV, and click the number its banner
shows.

| Device                  | Remote gesture                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| Linked to you           | Quick capture, a private draft for you. Toast `Captured · <your name>`.                                |
| Linked as a team device | Quick capture, a shared draft. Toast `Captured · team device`.                                         |
| Unlinked, debug build   | Quick capture, a shared draft. Toast `Captured · <device name>`. Also answers a dashboard link window. |
| Unlinked, release build | Nothing visible. Only answers a dashboard link window.                                                 |

- **Bindings.** In the dashboard's Quick capture card a binding is a long
  press, a sequence (keys in order within a time window) or a chord (keys held
  together). **Record on device** sets one from the remote you actually have:
  pick one of your linked TVs, relaunch the app or bring it to the foreground,
  and press the keys while it shows `Recording remote keys for 10 seconds`.
- **Key handling.** An unlinked TV never has a key swallowed or changed, so
  `TVEventHandler` sees every event as before. On a linked TV the first press
  always reaches the app, so holding Play/Pause toggles playback once when the
  press starts, before the capture. Once the gesture is recognized, a long
  press's repeats are swallowed and its key-up arrives canceled; a sequence or
  chord swallows only the key that completes it.
- **Debug builds** follow `__DEV__` (or `debugBuild`), as on phones.
- Everything else (end users, replay, takeover, unlinking, token storage and
  the off switches) works as on phones. Apple TV gets no remote gesture yet.

For the full rules, see the iOS SDK README's "Real iPhones and iPads" section
and the Android SDK README's "Quick capture on real phones" and "Quick capture
on Android TV" sections.

Apart from quick capture, gestures and keys are host-owned. The host app
calls `useEverframe().open()` (or the top-level `open()`)
from whatever trigger makes sense for the target form factor.

For TV, the canonical pattern uses `TVEventHandler` (exposed by
`react-native-tvos`).

#### API shape (react-native-tvos@0.85.3-0)

```ts
import { TVEventHandler } from 'react-native';

type HWEvent = {
  eventType:
    | 'menu' | 'playPause' | 'longPlayPause' | 'select'
    | 'up' | 'down' | 'left' | 'right'
    | 'longUp' | 'longDown' | 'longLeft' | 'longRight'
    | 'pan' | string;
  eventKeyAction?: -1 | 0 | 1 | number;   // 0 = down, 1 = up, -1 = unknown
  tag?: number;
  body?: { state: 'Began' | 'Changed' | 'Ended'; x: number; y: number; velocityX: number; velocityY: number };
};

const subscription = TVEventHandler.addListener((evt: HWEvent) => { /* ... */ });
subscription?.remove();
```

> If you have seen the older `new TVEventHandler(); handler.enable(cmp, cb);
handler.disable()` shape elsewhere — that class-based API was removed in
> RN-tvos 0.85.x. Always read the version installed in your `node_modules`.

#### Apple TV: long-press Play/Pause

```tsx
import { Platform, TVEventHandler } from 'react-native';
import { useEverframe } from '@everframe/react-native';
import { useEffect } from 'react';

function useAppleTVReporterTrigger() {
  const { open } = useEverframe();
  useEffect(() => {
    if (!(Platform.isTV && Platform.OS === 'ios')) return;
    const sub = TVEventHandler.addListener((evt) => {
      if (evt.eventType !== 'longPlayPause') return;
      if (Number(evt.eventKeyAction) !== 1) return; // key-up only
      void open();
    });
    return () => sub?.remove();
  }, [open]);
}
```

> **Why `longPlayPause` instead of `menu`?** `.menu` is reserved by Apple as
> the system back-navigation gesture on the Siri Remote — apps that bind it
> for a non-navigation purpose are App Store-rejected. Everframe's iOS SDK
> enforces this via `ReservedKeysValidator`; the same constraint applies on
> RN. `longPlayPause` is a native long-press event emitted by the OS
> (no JS timing required).

#### Android TV: KEYCODE_MENU

```tsx
import { Platform, TVEventHandler } from 'react-native';
import { useEverframe } from '@everframe/react-native';
import { useEffect } from 'react';

function useAndroidTVReporterTrigger() {
  const { open } = useEverframe();
  useEffect(() => {
    if (!(Platform.isTV && Platform.OS === 'android')) return;
    const sub = TVEventHandler.addListener((evt) => {
      if (evt.eventType !== 'menu') return;
      if (Number(evt.eventKeyAction) !== 1) return; // key-up only
      void open();
    });
    return () => sub?.remove();
  }, [open]);
}
```

`KEYCODE_MENU` is mapped to `eventType === 'menu'` by
`ReactAndroidHWInputDeviceHelper` (RN-tvos). It is the conventional
"settings / debug menu" key on Android TV remotes.

### Canonical example

The dogfood sample app at
[`examples/react-native/src/screens/Home.tsx`](https://github.com/scriptx-com/everframe/tree/main/examples/react-native/src/screens/Home.tsx)
implements both recipes side-by-side, gated by `Platform.isTV` +
`Platform.OS`. Cloned from the repo, build it with:

```bash
pnpm --filter examples-react-native ios:tv      # Apple TV simulator
pnpm --filter examples-react-native android:tv  # Android TV emulator
```

That example's own README covers prebuild details and the known pitfalls of
the TV targets.

### What about the floating bubble?

The iPhone floating-bubble overlay shipped in Phase 04 is NOT exposed via
the RN bridge today (and would not make sense on TV anyway — the focus
engine is the input model, not a touch-positioned overlay). On phone RN
hosts, add your own host-level button. On TV hosts, use the remote
recipes above.

---

## Android reporter initialization

The Android reporter can be opened after the host activity has resumed, including
apps that disable AndroidX Startup. The bridge supplies the current resumed
activity, and installation and presentation run on the main thread. Repeated
configuration does not register another lifecycle observer. Capture configuration
remains synchronous without waiting for reporter UI initialization. A failure
while opening is reported to JavaScript. Background or unavailable activities
return a cancelled result with reason `no_active_activity`.

Activity destruction while a reporter is open resolves the pending call with
`{ status: "cancelled", reason: "activity_destroyed" }`, releases that report's
frozen replay capture, and clears presenting state so the reporter can open
again. Backgrounding alone does not cancel the dialog. Once Send is tapped,
submission owns the result and continues independently of activity destruction;
its normal delivery result is preserved. Unsaved drafts are not restored after
activity recreation.

## License

MIT

### Optional interaction target annotations

Phone taps and TV remote interactions automatically use the available native
control role, accessibility label, test ID, visible text, and screen marker.
Reporting and automatic breadcrumbs work without app annotations. Logical
collection positions are included only when known; mounted children are never
used as the total item count.

Use `useEverframeTarget` on an existing host to add product names or logical
collection metadata:

```tsx
import { useEverframeTarget } from '@everframe/react-native';

const targetRef = useEverframeTarget({
  testId: 'poster-low-orbit', role: 'button', name: 'Low Orbit',
  container: { testId: 'home-originals', name: 'Originals', role: 'list', index: 0, count: 12 },
});
return <Pressable ref={targetRef} onPress={openTitle}><Text>Low Orbit</Text></Pressable>;
```

Indices are zero-based logical positions in the collection. An explicit
container replaces the automatic container as a unit. Updating the annotation
updates the existing host without waiting for `onLayout`; passing `undefined`
removes it. Strings are bounded to 256 UTF-16 units (roles: 64). Do not put
secrets or user-entered values into annotations. Existing sensitive-view masking
takes precedence and suppresses names, IDs, containers, and screen metadata.

Compose with an existing ref using a stable callback (return no value):

```tsx
const ref = React.useCallback((node: React.ElementRef<typeof View> | null) => {
  existingRef.current = node;
  targetRef(node);
}, [targetRef]);
```

Custom components must forward the ref to their native host. For a layout-only
`View`, use `collapsable={false}` so a host exists. Unsupported custom refs,
missing providers, and older native binaries fail softly. This feature requires
a native rebuild to enable annotation registration; it cannot be enabled by a
JavaScript-only update. The web export accepts the same type and is a no-op.
No wrapper, `onPress` replacement, or manual breadcrumb is needed.

Native registrations use weak host references and cancel stale ref generations.
After 4096 distinct registrations in one native session, optional annotations
fail closed until SDK restart; automatic target extraction continues. This
bound prevents delayed work from resurrecting evicted registration ownership.

Native target qualification uses the installed Fabric fixture under
`__tests__/fixtures/interaction-targets`. Rebuild native binaries after upgrading.
The iOS sensitive wrapper retains its native host and resolves it through the
Fabric view registry, so masked descendants stay excluded from target labels.

### State labels (iOS and Android)

`setState(key, value)` records a string, finite number, or boolean diagnostic label;
`clearState(key)` removes it. Both are also available from `useEverframe()`.
Call after the provider mounts. State is redacted, bounded, and frozen with report
evidence. See [State API](../../docs/state.md) for lifecycle, privacy, limits and
native recovery freshness.

## Semantic interaction evidence

On iOS, Android and their TV variants, supported native controls record text edits,
control changes and completed scroll gestures automatically. Existing taps and
reporting continue to work without hooks. Programmatic text/control updates do not
represent user interaction. TV focus movement only counts as scrolling when the
native content offset changes.

Text evidence contains its UTF-16 length by default. Secure or sensitive fields
produce no text evidence, including length. To permit a value locally, configure
an exact native `testID`:

```tsx
<EverframeProvider config={{
  sdkKey: 'txx_…',
  interactions: { valueTestIds: ['search-input'] },
}}>
  <App />
</EverframeProvider>
```

Optional values are redacted and limited to 256 UTF-16 units. Allowlisting a name
only in hook metadata never grants permission: the live native host must carry
that exact `testID`. Setting `interactions: { disabled: true }` disables these
semantic events without changing existing tap/error capture.

Use `useEverframeInteraction` to add target metadata to an existing native host.
Its ref adds no wrapper or app handler. Compose it with any existing app ref:

```tsx
import { useEverframeInteraction } from '@everframe/react-native';
import type { ElementRef } from 'react';
import { TextInput } from 'react-native';

function SearchField() {
  const interaction = useEverframeInteraction<ElementRef<typeof TextInput>>({
    target: { testId: 'search-input', name: 'Search' },
  });
  return <TextInput testID="search-input" ref={interaction.ref} />;
}
```

Native observation owns text, control and scroll evidence. `helperTypes` is
retained for source compatibility and always registers an empty list, including
legacy declarations. Each native bridge also strips helper ownership from older
JavaScript callers, so these declarations never suppress automatic observation.
Existing tap evidence is preserved. Missing providers, unsupported refs, older
native binaries and the web entry safely leave metadata registration inactive.

`textChanged(text, options?)`, `controlChanged(change)` and
`scrollSettled(change)` are compatibility no-ops. They never inspect their
payloads or send values, lengths or state across the bridge. JavaScript callbacks
cannot prove whether a host was sensitive when the observation originated;
checking after it is unmasked would be too late. Custom JavaScript controls
without a supported native observation point produce missing semantic evidence.

Clearing evidence, signing out or changing native capture configuration revokes
pending work. A queued callback keeps its original ownership and cannot renew it.
An unchanged mounted hook does not replay old metadata; a fresh committed host
attachment or metadata change can register again.

Text coalesces after 750 ms of inactivity, editing end, submission or safe report
freeze. An unfinished native composition retains only the last observed user-edit
length, without its value. If the keyboard ends composition without another text
change after the idle check, that summary waits for editing end or safe report
freeze. Its length describes the observed edit, including when the app later
replaces the text; it is not a newly sampled final value.
Scrolls coalesce at gesture completion or after 200 ms of inactivity.
Semantic events share a 20-per-10-second budget; text and scroll also share a
one-per-second budget per host. Values are bounded again after final redaction.

Incoming links are observed through React Native's existing `Linking` channel while the provider is mounted. The SDK does not route links. By default, evidence contains only scheme and host; valid opaque or hostless links retain only their scheme (for example `myapp:`). Parsing works in bare React Native without a global URL patch. Declare known route templates (for example `/watch/:id`) and exact query keys in `interactions.urlRules` to include more. Credentials, fragments and actual dynamic path segments are omitted; ambiguous encoded separators and dot segments are rejected. The initial URL is considered once per JS process. If capture is disabled at that first mount, it is omitted permanently; later mounts and re-enabling capture observe only fresh URL callbacks. The mounted subscription stays active while local policy enables it, and each new callback checks the current native capture lease. Distinct URL callbacks remain distinct observations even when their URLs match, because React Native supplies no delivery ID.

Observe an existing permission operation without changing its result:

```ts
import { observePermissionRequest, recordLaunchContext } from '@everframe/react-native';
import { PermissionsAndroid } from 'react-native';

const result = await observePermissionRequest('android.permission.CAMERA', () =>
  PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA),
);

// For an existing notification integration; call during the matching foreground entry.
recordLaunchContext({ trigger: 'notification', arguments: { campaign: 'autumn' } });
```

Without a mapper, the permission observer recognizes Android's `granted`, `denied` and `never_ask_again` results. Supply a mapper returning `granted`, `denied`, `blocked`, `limited`, `unavailable` or `unknown` for iOS or third-party APIs. The operation runs exactly once; its original value or rejection is preserved. A mapper failure or rejected request is recorded as `unknown`, never inferred as denial. A result does not prove a system dialog was shown. TV APIs that do not support a permission should map their actual result to `unavailable`.

Launch context enriches only a native foreground entry that is still pending (up to 250 ms, ending earlier on report freeze or background). It cannot create a launch, change cold/warm classification, or alter a frozen report. Late context is omitted. Only exact `interactions.launchArgumentKeys` allowlisted primitive values are accepted, at most 16 entries and 128 UTF-16 units per string. URLs belong to link evidence and are omitted from launch arguments. No arguments are captured by default.

Permission operations still run without a provider, with older native binaries and on web. Launch context is a no-op in those cases. A clear, sign-out or native configuration change revokes in-flight observations; it does not cancel the app's operation.

Target annotations enrich supported automatic native observations, including IME composition and optional allowlisted values. Native integrations that observe controls directly on the UI thread can supply native helpers with original privacy proof; the JavaScript compatibility methods cannot provide that proof.

### Reporter boundaries and developer tools

Native phone reporter opens and companion report requests add this custom breadcrumb before freezing evidence:

```json
{"kind":"custom","message":"reporter_opened","data":{"source":"everframe_reporter","trigger":"button"}}
```

`trigger` is `button`, `shake`, `menu`, or `companion`. Pending text/scroll summaries are flushed before this boundary. Native shake uses `shake`; companion report requests use `companion`; existing `open()` calls use `button`. To identify a host menu entry explicitly, call `open({ trigger: 'menu' })`. Closing or cancelling the native flow adds `reporter_closed` with `data.source: 'everframe_reporter'` to the live trail. Both events retain breadcrumb capture/config gates.

A reporter call crosses the React Native bridge after its native input can already have been recorded. It cannot prove that the previous tap or remote key opened the reporter. For a button, annotate its native host ref before interaction:

```tsx
const reporterRef = useEverframeTarget({ reporterTrigger: 'button' });
const { open } = useEverframe();
return <Pressable ref={reporterRef} onPress={() => void open()}><Text>Report</Text></Pressable>;
```

That target's tap/activation carries `data.origin: 'reporter'` and `data.trigger: 'button'`. On a remote, only Select/Enter activation is attributed to a `button` target; arrows, Menu and Play/Pause retain their ordinary meaning. An explicitly annotated `reporterTrigger: 'menu'` target attributes only its Menu activation. Attribution survives masking without retaining the target's text. Removing/recycling the bound ref removes attribution.

Hosts owning a reporting flow outside `open()` can `await markReporterOpened('menu')` before showing their reporter UI and `await markReporterClosed()` when it closes. These promises resolve after the native UI-thread boundary work; await them before adding subsequent host breadcrumbs or changing reporter UI. These explicit markers do not claim or remove earlier native keys: a TV event callback may run after native key capture. Use companion report-request boundaries when a host cannot attribute the original remote trigger. Never infer reporter intent from a button label, a Menu/Play/Pause key, or proximity to `open()`.

Native target capture adds `data.origin: 'devtools'` to supported taps and structured text/control/scroll observations whose native ancestry belongs to React Native LogBox, the native development menu, or Expo development-client UI. This comes from framework view/window/controller identity, an RN-owned development-menu controller, or a framework root module identity. In a development host, the inline LogBox notification/inspector is also registered by the exact React Native component exports through the existing React DevTools commit hook; application components with the same name are not attributed. This observer reads component identity and native refs, never warning text or component props, and removes registrations when their committed hosts disappear or the provider unmounts. Production JavaScript leaves this observer inert. A development JavaScript host can still attribute LogBox when its native SDK was built in Release mode. Display text such as “Dismiss” never grants an origin. A missing React DevTools hook, unavailable RN private module exports at runtime, initial asynchronous module loading, unknown framework versions and surfaces outside the native capture adapters leave attribution unavailable; origin tagging does not install a new dialog capture mechanism. The observer depends on the LogBox module paths in supported React Native versions; a future version removing those paths requires an SDK compatibility update before Metro can bundle it.

Consumers should use the latest active reporter interval (matching `reporter_opened`/`reporter_closed` markers by ordered trail), cut before its explicitly attributed triggering interaction when present, and otherwise before its opened marker. Closed reporter intervals can also be excluded while preserving application actions after their closing marker. Developer-tool observations can be excluded by their explicit `data.origin`. A cancelled earlier report must not become the boundary for a later report. Legacy trails lacking these fields remain valid and supply no new attribution evidence.
