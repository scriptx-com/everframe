<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/react-native — Sample App (Expo managed)

This app demonstrates reporter setup, handled and unhandled error capture,
session evidence, and TV/mobile host integration.

Expo SDK 56-managed sample that consumes `@traceitx/react-native` via the
workspace and demonstrates the canonical integration shape: `<TraceItXProvider>`
at the root, host-owned triggers calling `useTraceItX().open()`, the
provider-rendered reporter modal, submit, done.

The demo is **Elytra**, a small insect field guide ("file a bug about a bug")
— the RN sibling of `examples/react-web`, with the same naturalist design
tokens (`src/theme.ts`) and generative SVG specimen plates. Multi-tab so the
reporter has something real to capture: tabs to switch, a 140-record list to
scroll, plates to screenshot, and seeded PII to redact.

## Screens

Pure-JS bottom tab bar (`src/components/TabBar.tsx`) — deliberately NOT
`@react-navigation`; `react-native-safe-area-context`'s native module is
incompatible with react-native-tvos@0.85.3-0 (see `App.tsx` header).

- **Desk** (`Home.tsx`) — error-test buttons + hero plate + programmatic `open()` button + TV
  trigger hints
- **Specimens** — catalog grid, order filters, in-place detail with a
  `<TraceItXSensitive>` region
- **Log** (`FieldLog.tsx`) — interactive list (add / confirm / delete) plus
  two seasons of deterministic archive records in one long SectionList
  (sticky headers deliberately off — Paper-renderer shim absent under
  bridgeless RN-tvos; see the code comment)
- **Profile** (`Form.tsx`) — seeded PII card (canonical test-card + bearer
  strings), redacted vs public TextInput comparison, `setExtra()` demo, and a
  `setUser()` sign-in / switch / sign-out control (see **Recognition** below)
- **Companion** — phone-companion QR pairing (relay connects when the tab
  first opens)

Android autolinking explicitly excludes the unused `react-native-safe-area-context`
module. The sample uses manual insets; registering that module's Fabric descriptors
with this RN TV fork caused a native startup abort in the Release build.

## Error capture tests

Open **Desk → Error tests** on Android or iOS:

1. **Handled error** throws and catches `rn-error-test:handled-top-level`,
   then calls the public `captureException(error)` function.
2. **Handled error via hook** throws and catches `rn-error-test:handled-hook`,
   then calls `useTraceItX().captureException(error)`.
3. **Unhandled JS error** throws `rn-error-test:unhandled` in a timer, allowing
   the SDK's automatic ErrorUtils handler to observe it. It may show the dev
   error overlay or terminate the app; relaunch afterward to check delivery.

Use the app's SDK key and a reachable local API. The card shows whether a key
is configured, not whether the native SDK has started. Its status text records
the attempted call, not a storage or upload acknowledgement. In admin, check
the error message, real stack frames, platform, and `handled`/`mechanism`
classification. Handled captures should show `handled: true` and
`mechanism: captureException`; automatic captures use `errorutils`.

Restart the app between runs: the SDK deduplicates repeated handled errors at
the same location during a mounted lifetime. Old native binaries may lack the
handled-capture bridge; rebuild the native app after SDK changes. These tests
exercise JavaScript errors, not native JVM/Swift crashes. Debug stacks do not
prove release Hermes mapping; that requires the matching release bundle and
private source maps described below.

Automation testIDs: `trigger-handled-error`, `trigger-handled-hook-error`,
`trigger-unhandled-error`, and `error-test-status`.

## Recognition — this app is the self-declared tier

TraceItX has two recognition tiers, and the two sample apps demonstrate one
each on purpose:

| | this app | `examples/react-web` |
|---|---|---|
| API | `setUser({ id, email, displayName })` | `setIdentityToken(() => …)` |
| Backed by | nothing | a short-lived JWT its own backend signs |
| Needs a backend | no | yes |
| Dashboard shows | badged **Unverified** | plain, verified |
| Can unlock a person's conversations on another device | never | yes |

`setUser` is an **assertion, not a credential**. Anyone able to run this app's
code — or holding its publishable SDK key, which ships inside the bundle —
could claim any identifier. It labels and groups reports so `/people` is
useful; it never widens what anyone can read. That is exactly the trade a
React Native app with no backend of its own should be able to make.

Two things the Profile tab demonstrates that are easy to get wrong:

- **Call it after the SDK starts.** A `setUser` issued before `start()` is
  dropped on every platform, silently, leaving the whole session anonymous.
  Wire it to your sign-in completing, not to app construction.
- **Clearing on React Native is `setUser()` with no argument.** The
  TurboModule bridge forbids a nullable object parameter, so omission is how
  "no user" is expressed here. On web, iOS and Android it is `setUser(null)`.

Maestro testIDs: `sign-in-collector-8891`, `sign-in-collector-2277`,
`sign-out`, `recognition-status`.

The floating **Report a bug** button (`src/components/ReportFab.tsx`) is
pinned to the bottom-right corner of every tab. It carries the Maestro
testIDs `open-reporter-button` + `submitted`, and owns the TV remote trigger
(Apple TV long-press Play/Pause; Android TV Menu).

> **Cross-tool coexistence is intentionally NOT proved here.** Earlier
> revisions bundled `@sentry/react-native` + `@bugsnag/react-native` to
> dogfood URLSession/OkHttp interceptor coexistence. That concern is real
> and remains separate from the error-capture checks here. One sample app
> is only one cell of the 5×2 coexistence matrix.
> The matrix `TraceItX × {Sentry, Bugsnag, Datadog, New Relic, Crashlytics}
> × {iOS, Android}` moved to Phase 7 hardening (ROADMAP Phase 7 criterion 6,
> 2026-05-11).

> **Why Expo?** The sample is an integration testbed, not a production app.
> Expo's prebuild pipeline owns `pod install`, Gradle plugin pinning, and
> Xcode/Android Studio scaffolding so contributors don't manage native
> toolchain drift — they run `expo prebuild` + `expo run:ios` and Expo
> handles the rest. The TraceItX SDK packages themselves stay framework-
> agnostic; only this sample app is Expo-aware.

The sample exists to **prove the integration boundary**:

- **Host-owned triggers only.** One floating corner button + the TV remote
  listener — no shake-detection, no gesture library in the SDK; those are
  HOST-app concerns
  ([feedback_triggers_are_host_concern.md](../../.claude/projects/-Users-evaldasstonys-scriptx-traceitx/memory/feedback_triggers_are_host_concern.md)).
  See the [Trigger recipes](#trigger-recipes-host-app-snippets) section for motion + hardware-key snippets integrators copy into their own host code.
- **Provider-owned configuration.** `App.tsx` wraps the subtree in
  `<TraceItXProvider config={...}>` (Plan 06-05). Nothing reaches into
  module-top `TraceItX.configure(...)`.
- **iPhone + Android phone only.** Apple TV and Android TV are out of scope
  for this milestone (Plan 06 decision D-01).

---

## Prerequisites

- Node 22+, pnpm 9+ (repo root)
- For iOS: macOS 13.4+ with Xcode 26.4+ (Expo SDK 56 minimum)
- For Android: JDK 17 + Android command-line tools (Expo CLI auto-installs SDK 35)
- The local ingest service running: `pnpm dev:api` (see Phase 8 DX-01)

Native dirs (`ios/`, `android/`) are **NOT committed**. They are regenerated
on demand by `expo prebuild` from `app.json` + `plugins/with-traceitx-workspace.js`.

---

## Initial setup

```bash
# From repo root
pnpm install

# Build the SDK package so dist types are visible to the sample's typecheck.
pnpm turbo run build --filter=@traceitx/react-native

# From examples/react-native — generate native dirs once
pnpm prebuild
```

`pnpm prebuild` runs `expo prebuild --clean`, which:

1. Reads `app.json` → `expo.plugins` and applies each plugin.
2. `expo-build-properties` sets `use_frameworks! :linkage => :dynamic` in the generated `Podfile` (required — see below).
3. `./plugins/with-traceitx-workspace.js` appends `includeBuild("../../../packages/sdk-android/android") { name = "traceitx-android" }` to the generated `android/settings.gradle.kts` so `:traceitx-core` / `:traceitx-reporter-ui` resolve from the workspace, not from a published Maven artifact.
4. React Native autolinking discovers `@traceitx/react-native` via the pnpm-symlinked `node_modules` and wires the iOS pod + Android module automatically.

> **Why dynamic frameworks?** The `TraceItX` pod consumes `packages/sdk-ios`
> via `spm_dependency` (a local-path SwiftPM dep). SPM products and the host
> pod must agree on dynamic linkage; static linkage collides at link time.

---

## Running

From the repository root, create `.env`, set `TRACEITX_KEY_RN`, then run
`pnpm gen-rn-config`. Start a platform with one of:

```sh
pnpm --filter examples-react-native ios
pnpm --filter examples-react-native android
pnpm --filter examples-react-native ios:tv
pnpm --filter examples-react-native android:tv
```

The app opens to a screen with:

- An **Open Reporter** button → calls `useTraceItX().open()`.
- A bottom panel demonstrating `<TraceItXSensitive>` wrapping a secure text
  field — the redactor blurs/blackboxes this region in the captured screenshot
  before it ever leaves the device.

---

## Trigger recipes (host-app snippets)

The SDK exposes `useTraceItX().open()` and nothing else. Wire your
own trigger from the host:

### Button (this sample's choice)

```tsx
import { Pressable, Text } from 'react-native';
import { useTraceItX } from '@traceitx/react-native';

function ReportButton() {
  const { open } = useTraceItX();
  return (
    <Pressable onPress={() => open()}>
      <Text>Report a bug</Text>
    </Pressable>
  );
}
```

### Motion-based (HOST-app code, NOT shipped by the SDK)

```tsx
// npm install react-native-sensors  (or any equivalent — your choice)
import { accelerometer } from 'react-native-sensors';
import { useEffect } from 'react';
import { useTraceItX } from '@traceitx/react-native';

function useMotionTrigger() {
  const { open } = useTraceItX();
  useEffect(() => {
    const sub = accelerometer.subscribe(({ x, y, z }) => {
      const magnitude = Math.sqrt(x * x + y * y + z * z);
      if (magnitude > 25) open();
    });
    return () => sub.unsubscribe();
  }, [report]);
}
```

### Hardware-key combo (HOST-app code)

```tsx
import { useEffect } from 'react';
import { HWKeyEvent } from 'your-host-key-lib';
import { useTraceItX } from '@traceitx/react-native';

function useKeyComboTrigger() {
  const { open } = useTraceItX();
  useEffect(() => {
    const unsub = HWKeyEvent.on('VolumeUp+VolumeDown', () => open());
    return unsub;
  }, [report]);
}
```

**These snippets are NOT SDK exports.** The SDK has zero gesture / motion /
key-detection code (Phase 5.1 cleanup; see
`feedback_triggers_are_host_concern.md`).

---

## External integrator path

When you consume `@traceitx/react-native` from outside this monorepo, do
not use the workspace composite-build plugin:

- **iOS:** standard `react-native autolinking` picks up the pod from
  `node_modules/@traceitx/react-native/ios/TraceItX.podspec`. Your host
  Podfile must include `use_frameworks! :linkage => :dynamic` (Expo apps:
  add `expo-build-properties` with `ios.useFrameworks: "dynamic"` to your
  `app.json` plugins; bare RN apps: add the line to your Podfile directly).
  The pod pulls `@traceitx/ios` from the published SwiftPM mirror.
- **Android:** drop `./plugins/with-traceitx-workspace.js` from your
  `app.json` plugins. Autolinking finds `@traceitx/react-native`'s
  Android Gradle module via `node_modules`, and that module pulls
  `com.traceitx:core` from the published Maven coordinates.

---

## Maestro smoke

```bash
# One-time install
curl -Ls "https://get.maestro.mobile.dev" | bash

# From examples/react-native:
pnpm maestro:smoke
# (or directly: maestro test maestro/coexistence-smoke.yaml)
```

The flow proves: launch → host button visible → tap → reporter modal opens
→ title input → submit → submitted label.

---

## File map

| File | Purpose |
|------|---------|
| `app.json` | Expo config — bundle ids, plugins, `newArchEnabled: true` |
| `plugins/with-traceitx-workspace.js` | Config plugin — injects Android `includeBuild` for workspace composite-build |
| `index.js` | Expo entry — `registerRootComponent(App)` |
| `src/App.tsx` | Root — `<TraceItXProvider>` mount + configure-on-mount |
| `src/screens/Home.tsx` | Open Reporter button + submitted label |
| `src/screens/Form.tsx` | `<TraceItXSensitive>` redaction demo |
| `babel.config.js` | `babel-preset-expo` + `@traceitx/babel-plugin-displayname` (Pitfall P11) |
| `metro.config.js` | `expo/metro-config` + pnpm-workspace-aware resolver |
| `maestro/reporter-smoke.yaml` | Maestro flow: launch + reporter + submit |
| `.gitignore` | Excludes generated `ios/` + `android/` from git |

Generated (not committed):

| Dir | Source of truth |
|-----|------------------|
| `ios/` | `app.json` → `expo-build-properties` + RN autolinking |
| `android/` | `app.json` → `with-traceitx-workspace.js` + RN autolinking |

## Optional private Hermes maps

### Local optimized builds for manual error tests

After generating/running the normal native development hosts, this checkout
can build a Release Android arm64 APK and an iOS arm64 simulator app with
optimized, embedded Hermes bytecode. They use the local **Debug native SDK
artifacts** to keep traffic pointed at the local API (Android emulator:
`http://10.0.2.2:8787`; iOS simulator: `http://localhost:8787`). This validates
optimized JavaScript, not production native SDK configuration or R8 shrinking.
Keep the API running. Metro is not needed by these installed Release apps.

```sh
pnpm --filter examples-react-native build:error-test:android
pnpm --filter examples-react-native build:error-test:ios

# Use a private shell token with artifacts:write for the RN app's project.
export TRACEITX_APP_ID='<RN app UUID>'
export TRACEITX_API_URL='http://localhost:8787/api/v1'
pnpm --filter examples-react-native upload:source-maps:android
pnpm --filter examples-react-native upload:source-maps:ios

# Target the intended running emulator/simulator explicitly.
TRACEITX_ANDROID_SERIAL=emulator-5554 pnpm --filter examples-react-native install:error-test:android
TRACEITX_IOS_SIMULATOR='<simulator UUID>' pnpm --filter examples-react-native install:error-test:ios
```

Set `JAVA_HOME` and `ANDROID_HOME` as for the normal Android runner. The helper
requires already built local SDK/CLI artifacts and generated native hosts; it
does not regenerate or wipe them. It uses `TRACEITX_KEY_RN` from the root
`.env` (or the shell), with `EXPO_PUBLIC_TRACEITX_KEY` as an explicit override.
The uploader's `TRACEITX_API_TOKEN` must be supplied privately in the shell;
it is never forwarded to native build tools. The helper reads no other root
`.env` values.

Each build gets a fresh platform-specific JS identity. Final bytecode, composed
map, installable artifact and `latest.json` hash receipt are saved under the
ignored `.hermes-error-test/<platform>/` directory. Upload/install refuse
changed files, and installation requires a successful upload. Android's APK
uses the example's debug signing key. A temporary release manifest permits
local HTTP during this test build and is removed afterward. Maps stay outside
both APK and app resources. Keep these local test builds out of distribution.
The iOS simulator build uses ad hoc signing with Xcode's simulated application
entitlement. Do not disable signing: Keychain access is required to encrypt the
crash outbox, even in the simulator.

Launch **TraceItX RN Example → Desk → Error tests**. Confirm the displayed
`rn-test-android-…` or `rn-test-ios-…` build ID, then trigger each error. In
admin, confirm the matching `jsBundle` identity and mapped `ErrorTests.tsx`
throw location. Fully terminate/relaunch after the unhandled test so the
persisted fatal report can drain. A subsequent rebuild requires another upload;
do not combine an older map with new bytecode.

For release/OTA builds, pass an explicit `jsBundle: { buildId, bundleName }` in
`TRACEITX_CONFIG` before bundling. Use a unique per-platform JavaScript build ID;
the native app build is not a substitute. Typical names are
`index.android.bundle` on Android and `main.jsbundle` on iOS. Leave this optional
metadata unset for ordinary local development.

Use the TraceItX dashboard's source-map instructions for the exact final
bytecode/composed-map paths and trusted CI upload credentials. Upload tokens
never belong in this example's public config. Physical devices, production
native SDK configuration and Expo/OTA integration require separate validation.
