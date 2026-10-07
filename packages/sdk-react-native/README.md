<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/react-native

Everframe React Native bridge — exposes the native iOS and Android reporter
modal to RN host apps via a TurboModule + a thin React provider/hook API.

> Phone, Apple TV, and Android TV are all supported when the host app is
> built against `react-native-tvos` (see [TV Host Integration](#tv-host-integration-apple-tv--android-tv)).

---

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

## Usage

Wrap your app with `<EverframeProvider>` at the highest practical level
(above any navigator / focus engine root):

```tsx
import { EverframeProvider, useEverframe } from '@everframe/react-native';

export default function App() {
  return (
    // `apiKey` is the only required field. The ingest endpoint is a
    // compile-time constant in the SDK and is not configurable in v1.
    <EverframeProvider
      config={{
        apiKey: 'txx_live_xxxxxxxxxxxxxxxx',
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

## Promise rejection observation

Automatic Hermes rejection observation is opt-in:

```tsx
import { EverframeProvider, getPromiseRejectionStatus } from '@everframe/react-native';

<EverframeProvider config={{
  apiKey: '…',
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
    <EverframeProvider config={{ apiKey: '…' }}>
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
`errorUtils`, and `rejection` (submission only). Each active attempt has one outcome:
`accepted`, `duplicateSuppressed`, `allowanceSuppressed`, `bridgeUnavailable`,
`nativeRefused`, `captureFailed`, `reentrantSuppressed`, `inactiveAborted`, or
`legacyAttempted`. Counters saturate at 2,147,483,647. Existing limits are ten
handled and ten automatic distinct keys; fatal capture bypasses them.

`accepted` requires exactly true from a current native capture method. It does
not mean upload success, server processing or outbox removal. An automatic call
to an older native fallback is only `legacyAttempted`, regardless of its return.
Old-binary unavailable/throwing methods are covered by unit controls, not an
installed old-binary qualification. This snapshot excludes native queue and
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
export is `unsupported/platform`. Older native SDKs without the getter return
`unsupported/native-method-missing`. A throwing native call returns
`unavailable/native-call-failed`, and malformed native responses return
`unavailable/invalid-native-snapshot`. These fallbacks have an unobserved queue
and `unknown` platform policies. This API does not provide a per-report delivery
guarantee or trigger a retry.

## Network body capture (client veto)

```tsx
<EverframeProvider config={{ apiKey: '…', networkBodies: { disabled: true } }}>
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

<EverframeProvider config={{ apiKey, integrations: [consoleIntegration(), txNav] }}>
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
<EverframeProvider config={{ apiKey, vitals: { enabled: true, sampleRate: 0.5, captureSourceQuery: false } }}>
```

- `enabled` — absent follows the dashboard toggle; `false` opts out locally;
  `true` never forces vitals on if the dashboard has them off.
- `sampleRate` — `[0, 1]`, `min()`'d with the server-configured rate.
- `captureSourceQuery` — keep the query string on `source_change.src`
  (default `false`: signed CDN URLs carry tokens in the query).

**Reconfiguring.** A Provider remount with the *same* config does not restart
the SDK: both native sides compare the incoming config against the *installed*
one and skip the start entirely. A **changed** config does restart it — and a
start supersedes the running SDK, detaching every player integration it had
announced. **Limitation:** players tracked before that restart stay untracked
until their screens remount; nothing re-registers them automatically. Two React
instances in one process are *not* coordinated either: if a second one starts
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
*first* `startup` measurement is missing (later source changes are fine).

Options: `name`, `libraryVersion`, and `captureErrors` (default `false` — see
Limitations). `onBandwidthUpdate` is read per platform: on iOS its `bitrate`
is the rendition's declared bitrate and drives `bitrate_change` plus the
`bitrate` stat; on Android it is ExoPlayer's bandwidth estimate, reported as
the `bandwidthEstimate` stat (with `quality_change` for the accompanying
rendition size) and never as a bitrate.

`onProgress` is read per platform too. The `bufferAheadMs` stat is always the
media time buffered *ahead of the playhead*: on Android `bufferDuration` is
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
  Note that the library *does* forward ExoPlayer's
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
<EverframeProvider config={{ apiKey }}>
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
menu also uses shake. Production remains enabled by default.

All other gestures and keys are host-owned. The host app
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
> handler.disable()` shape elsewhere — that class-based API was removed in
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
apps that disable AndroidX Startup. Use matching updated React Native bridge and
`dev.everframe:reporter-ui` artifacts: the bridge supplies the current resumed
activity, and installation and presentation run on the main thread. Repeated
configuration with matching updated artifacts does not register another lifecycle observer. Capture configuration
remains synchronous without waiting for reporter UI initialization.

The existing `ReporterResolverInstaller.create(Context)` entry point is retained
for compiled callers. A new bridge with an older reporter uses its legacy entry
point when the activity-aware method is absent; that combination retains the old
late-initialization limitation. A failure from an available method is reported,
not retried through the legacy path. Background or unavailable activities return
a cancelled result with reason `no_active_activity`.

Legacy off-main `create(Context)` schedules installation and returns before it is
ready; use the awaited activity-aware bridge to open immediately after configure.
With a new bridge and an older reporter, each configure, companion start, and
open invokes legacy installation again. This can add duplicate lifecycle
callbacks and overwrite that older reporter's resolver and activity supplier;
the previous bridge limited installation to once per module. Conversely, an old
compiled bridge with the new reporter can announce companion PIN capability
before asynchronous reporter installation finishes, temporarily advertising no
PIN support. Use the matching updated pair for the qualified behavior.

Activity destruction while a reporter is open resolves the pending call with
`{ status: "cancelled", reason: "activity_destroyed" }`, releases that report's
frozen replay capture, and clears presenting state so the reporter can open
again. Backgrounding alone does not cancel the dialog. Once Send is tapped,
submission owns the result and continues independently of activity destruction;
its normal delivery result is preserved. Unsaved drafts are not restored after
activity recreation.

## License

MIT
