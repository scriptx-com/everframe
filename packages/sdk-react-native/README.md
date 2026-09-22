<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/react-native

TraceItX React Native bridge — exposes the native iOS and Android reporter
modal to RN host apps via a TurboModule + a thin React provider/hook API.

> Phone, Apple TV, and Android TV are all supported when the host app is
> built against `react-native-tvos` (see [TV Host Integration](#tv-host-integration-apple-tv--android-tv)).

---

## Installation

```bash
pnpm add @traceitx/react-native
```

Peer dependencies: `react` ≥ 19, `react-native` (or `react-native-tvos` for
TV targets) ≥ 0.85.

Then install pods (iOS) / sync Gradle (Android) as usual:

```bash
cd ios && pod install
```

## Usage

Wrap your app with `<TraceItXProvider>` at the highest practical level
(above any navigator / focus engine root):

```tsx
import { TraceItXProvider, useTraceItX } from '@traceitx/react-native';

export default function App() {
  return (
    // `apiKey` is the only required field. The ingest endpoint is a
    // compile-time constant in the SDK and is not configurable in v1.
    <TraceItXProvider
      config={{
        apiKey: 'txx_live_xxxxxxxxxxxxxxxx',
        // Recommended in RN/Expo development: shake also opens the dev menu.
        shakeToReport: { enabled: !__DEV__ },
      }}
    >
      <RootNavigator />
    </TraceItXProvider>
  );
}
```

Trigger the reporter from any host UI:

```tsx
function HelpButton() {
  const { open } = useTraceItX();
  return <Button title="Report a bug" onPress={() => open()} />;
}
```

For non-component contexts, use the top-level `open` re-export
(throws `TraceItXNotMountedError` if the provider is not yet mounted):

```ts
import { open } from '@traceitx/react-native';
await open();
```

`open()` returns a `ReporterResult` with `{ status: 'submitted' |
'queued' | 'cancelled', ... }`.

For handled JavaScript exceptions, call `captureException(error)` from the
provider context and attach any non-sensitive context needed for diagnosis.
The source API requires matching rebuilt native components; published `0.7.0`
artifacts are not evidence of support.

## Network body capture (client veto)

```tsx
<TraceItXProvider config={{ apiKey: '…', networkBodies: { disabled: true } }}>
```

`networkBodies.disabled: true` is a **client veto** — it can only turn body
capture off locally; it can never turn it on. The server's per-app
`captureBodies` gate is still authoritative, and native network capture must
still be wired up on each platform (see below) before any body is ever
recorded.

**This option does not, by itself, make React Native capture network
bodies.** RN does not currently attach TraceItX's network capture to its own
HTTP clients (`fetch`, Axios, etc.) — that wiring is tracked separately and
is not part of this SDK yet. RN apps do still inherit the native SDK's own
auto-capture running underneath them, so `networkBodies` controls that
native capture — and even that requires the native side to actually be
capturing network traffic in the first place:

- **Android**: bodies are captured only for OkHttpClient instances the host
  app explicitly builds with `addTraceItXInterceptor()` (see
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
import { useTXScreen } from '@traceitx/react-native';
import { useIsFocused, useRoute } from '@react-navigation/native';

function DetailScreen() {
  useTXScreen(useRoute().name, { focused: useIsFocused() });
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
  useTXScreen('Desk');
  ...
}
```

Screen names should be route identifiers, never user content.

## Opt-in JS integrations

Native capture (taps, screens, lifecycle, errors) is automatic. Two things
live only in JS — console logs and navigator state — and are captured ONLY
when you opt in:

```tsx
import { consoleIntegration } from '@traceitx/react-native/integrations/console';
import { reactNavigationIntegration } from '@traceitx/react-native/integrations/react-navigation';
import { createNavigationContainerRef } from '@react-navigation/native';

const navigationRef = createNavigationContainerRef();
const txNav = reactNavigationIntegration({ navigationRef });

<TraceItXProvider config={{ apiKey, integrations: [consoleIntegration(), txNav] }}>
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
`recordScreen` — the `useTXScreen` recipes above cover Wix RNN and
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
<TraceItXProvider config={{ apiKey, vitals: { enabled: true, sampleRate: 0.5, captureSourceQuery: false } }}>
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
import { useVideoPlayerVitals } from '@traceitx/react-native/integrations/react-native-video';

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
import { attachTheoPlayerVitals } from '@traceitx/react-native/integrations/theoplayer';

<THEOplayerView onPlayerReady={(player) => attachTheoPlayerVitals(player, { name: 'main' })} />
```

Both adapters are pure translators: neither library is imported at runtime
or added as a dependency of this package.

### Custom log lines

```ts
import { trackVitals } from '@traceitx/react-native';

trackVitals('ad_break', { pod: 1 });
```

### Any other player: `trackPlayer`

Libraries without an adapter above (or a player object outside a component
tree) can drive the same pipeline directly:

```ts
import { trackPlayer } from '@traceitx/react-native';

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

`@traceitx/react-native` supports Apple TV + Android TV when consumed
from a host app built against `react-native-tvos`. This support is developed
against RN-tvos `0.85.3-0`, Expo SDK `56.0.0-preview.7`, and React `19.2.5`;
the canonical example app below is kept building on that matrix.

### Provider placement

`<TraceItXProvider>` MUST sit ABOVE the TV focus engine's root in the
component tree. The reporter is presented imperatively by the native side
(via `TXTVReporterViewController` on iOS / `:traceitx-tv` `ReporterActivity`
on Android), so React Native's focus engine never sees it — the native VC
manages focus on its own UIWindow / Activity.

```tsx
<TraceItXProvider config={{ apiKey }}>
  <NavigationContainer>{/* focus engine root */}</NavigationContainer>
</TraceItXProvider>
```

### Triggers are the host app's concern

TraceItX installs shake-to-report on Android and iOS phones/tablets through the
native SDKs. It is enabled by default, requires no permission, safely no-ops on
Android devices without an accelerometer, and never runs on Android TV or tvOS.
The dashboard is authoritative: local `enabled: true` cannot override a
dashboard disable.

In React Native and Expo development builds, use
`shakeToReport: { enabled: !__DEV__ }` because the React Native development
menu also uses shake. Production remains enabled by default.

All other gestures and keys are host-owned. The host app
calls `useTraceItX().open()` (or the top-level `open()`)
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
import { useTraceItX } from '@traceitx/react-native';
import { useEffect } from 'react';

function useAppleTVReporterTrigger() {
  const { open } = useTraceItX();
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
> for a non-navigation purpose are App Store-rejected. TraceItX's iOS SDK
> enforces this via `ReservedKeysValidator`; the same constraint applies on
> RN. `longPlayPause` is a native long-press event emitted by the OS
> (no JS timing required).

#### Android TV: KEYCODE_MENU

```tsx
import { Platform, TVEventHandler } from 'react-native';
import { useTraceItX } from '@traceitx/react-native';
import { useEffect } from 'react';

function useAndroidTVReporterTrigger() {
  const { open } = useTraceItX();
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
[`examples/react-native/src/screens/Home.tsx`](https://github.com/scriptx-com/traceitx-releases/tree/main/examples/react-native/src/screens/Home.tsx)
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

## License

MIT
