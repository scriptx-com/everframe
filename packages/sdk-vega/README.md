<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/vega

**Preview.** JavaScript crash and error reporting for Amazon Vega OS apps
built with React Native for Vega. No native module: the SDK is plain
JavaScript and installs on React Native 0.72 with Hermes 0.12.

What it reports:

- Uncaught JavaScript errors, fatal and non-fatal (`ErrorUtils`).
- Promise rejections still unhandled after about 2 seconds (Hermes' rejection
  tracker).
- Errors you pass to `captureException`.

What it does not report: native and C++ crashes, Hermes engine aborts, ANRs
and watchdog kills. Those never reach JavaScript; Vega OS records them in its
own crash reports. There is no screenshot, reporter UI, session replay or
companion mode on Vega OS. Team members can file quick captures from a linked
device with the remote (see [Quick capture on Vega OS](#quick-capture-on-vega-os)).

## Install

```sh
npm install @everframe/vega
```

At the top of `index.js`, before any `AppRegistry` call:

```js
import AsyncStorage from '@amazon-devices/react-native-async-storage__async-storage';
import * as Everframe from '@everframe/vega';

Everframe.init({
  sdkKey: 'evf_live_…',
  storage: AsyncStorage,
  appVersion: '1.4.0',
});
```

Pass `storage`. A fatal error ends the app a few milliseconds after the SDK
sees it; the SDK writes the report to storage first and sends it on the next
launch if it could not send it before the app stopped. Without storage that
report is lost.

## Readable stack traces

A release build's frames point into the compiled bundle. Upload the bundle's
source map after each release build and Everframe maps the frames back to your
source files:

```sh
EVERFRAME_API_TOKEN=… npx @everframe/cli sourcemaps upload-vega \
  --app-id <app id> --dir build/lib/rn-bundles/Release
```

The Vega CLI names each bundle by its SHA-256 and writes
`<id>.bundle.map` next to it. Every report carries that id, so a map uploaded
for one build never applies to another. Debug builds load the bundle from
Metro and are not mapped.

## API

| Call                                               |                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `init(config)`                                     | Start the SDK. Call once; later calls are ignored.                                                                                                                                                                                                                                                                                                       |
| `captureException(error, options?)`                | Report a caught error. `options`: `severity` (`info`, `warning`, `error`), `context` (a label), `metadata` (flat: strings, numbers, booleans, null). Keys that name a credential (`password`, `token`, `secret`, `apiKey`, `authorization`, `cookie`, in any case or spelling) keep their name and get `[REDACTED]` before the report is stored or sent. |
| `setUser(user \| null)`                            | `{ id?, email?, displayName? }` on later reports.                                                                                                                                                                                                                                                                                                        |
| `addBreadcrumb({ message, kind?, level?, data? })` | The latest 100 breadcrumbs ride on every report.                                                                                                                                                                                                                                                                                                         |
| `flush()`                                          | Resolves after stored reports were sent once.                                                                                                                                                                                                                                                                                                            |
| `getStatus()`                                      | `{ enabled, bundleId, rejections, pending }`.                                                                                                                                                                                                                                                                                                            |

## Configuration

| Key                          | Default                 |                                                                                                                                         |
| ---------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `sdkKey`                     | required                | Your Vega integration's SDK key. Without it the SDK stays off.                                                                          |
| `storage`                    | none                    | AsyncStorage, or any object with `getItem` and `setItem`.                                                                               |
| `appName`                    | `Vega app`              | Shown on reports.                                                                                                                       |
| `appVersion`                 | `0.0.0`                 | Your app version.                                                                                                                       |
| `appBuild`                   | none                    | A build number or CI build id.                                                                                                          |
| `debugBuild`                 | `__DEV__`               | Whether this is a debug build. Everframe never makes a release out of one.                                                              |
| `releaseHealth`              | `true`                  | Anonymous foreground sessions and fatal JavaScript release health; requires an explicit valid `appVersion`.                             |
| `captureUnhandledRejections` | `true`                  | `false` stops reporting promise rejections.                                                                                             |
| `device`                     | none                    | `{ model, osVersion }`, e.g. from `@amazon-devices/react-native-device-info`. React Native for Vega does not expose them to JavaScript. |
| `quickCaptureEnabled`        | `true`                  | Quick capture on linked devices. `false`: no root wrapper, no config request, no key listening.                                         |
| `enabled`                    | `true`                  | `false` turns the SDK off.                                                                                                              |
| `endpoint`                   | `https://everframe.dev` | For self-testing only.                                                                                                                  |

Dashboard settings (session replay, vitals, network bodies and the like) do
not apply. The SDK reads only the quick-capture and device-linking switches
from `/api/config`: one request per launch, and none with
`quickCaptureEnabled: false`.

## Quick capture on Vega OS

A team member's Vega device can file quick captures with the remote: a long
press of Play/Pause (about 1.5 s) files a capture attributed to the person or
team the device is linked to. It needs no code beyond `init()`. End users of
release builds see no change.

What a press does, when quick capture is on for the app in the dashboard:

| Device                    | Long press of Play/Pause                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Linked to a person        | Files a capture as that person's private draft. Toast `Captured · {name}`.                  |
| Linked as a team device   | Files a shared draft. Toast `Captured · team device`.                                       |
| Not linked, debug build   | Files a shared draft (toast `Captured · {device model}`) and offers the device for linking. |
| Not linked, release build | Nothing visible. Offers the device for linking if linking is on.                            |

A debug build is `debugBuild` when you pass it, else React Native's `__DEV__`.

**Linking a device.** In the dashboard, open Settings → Devices → Link a
device. On the device, long press Play/Pause for about 1.5 s. The device shows
`Linking to Everframe · 47`; pick the matching number in the dashboard. The
device then shows `Linked to {name}`. Choose "team device" to link it to the
team instead of yourself. Unlink a device from the same page; its next capture
shows `This device was unlinked`, nothing is filed, and it behaves as an
unlinked device again. If another teammate opens Link a device while you
capture from a linked device, the capture's reply offers the device to them;
when they pick its number, the device moves to them and that capture goes with
it.

**What a capture contains:** breadcrumbs, device, app and user details. There
is no screenshot and no replay on Vega OS (the SDK is JavaScript only). If a
capture cannot be sent right away it waits in `storage` and is retried, but
only while the device is still linked to the same person or team; otherwise it
is dropped, never filed under someone else.

**Remote keys.** The SDK only listens to keys; it never consumes one. A long
press of Play/Pause therefore also reaches your app, which typically toggles
playback once. Taps of Play/Pause, held D-pad keys and fast paging never take a
capture. While the device is not linked and linking is off, the SDK does no
work per key.

**The root wrapper.** `init()` installs a small root component with
`AppRegistry.setWrapperComponentProvider`. It draws the linking banner and the
toasts above your app without taking focus, and listens to remote keys with
`useTVEventHandler`. Call `init()` before any `AppRegistry` call: a wrapper
provider your app sets after `init()` is kept and rendered inside the SDK's,
but one set before `init()` is replaced.

**Security.** The device link is a token stored in the `storage` you pass
(AsyncStorage; React Native for Vega has no secure storage API for
JavaScript), bound to the endpoint and SDK key it was issued for, so a staging
build never sends a production token. The token goes only in the
`X-Everframe-Capture-Token` header of quick-capture uploads and config
requests, and is never logged or put in a URL; a queued capture stores a
one-way fingerprint of it, not the token. React Native for Vega's `fetch`
follows HTTP redirects even when told not to, and forwards `X-Everframe-*`
headers (not `Authorization`) to the redirect target, including another
origin. The SDK discards any redirected response and never stores a token
from one, but it cannot stop the request itself: point `endpoint` only at a
server you trust not to redirect.

Set `quickCaptureEnabled: false` to turn all of this off.

## How delivery works

Reports are JSON `POST`s to `/api/ingest`; Vega OS networking drops
multipart bodies. Each report is stored before it is sent, retried with
backoff while the app runs and on the next launches (up to 8 attempts or 7
days), and removed once the server accepts or permanently rejects it. A resend
carries the same report id, so the server stores it once. A stored report is
bound to the endpoint and SDK key it was captured under (the key as a
one-way fingerprint, never the key itself): if a later launch is configured with
another key or endpoint, the report is dropped, never sent elsewhere. At most 10 reports
wait at a time; non-fatal ones are dropped first.

Per launch, the same automatic error from the same place is reported once,
and at most 10 distinct automatic and 10 distinct handled errors are
reported. Fatal errors are always reported.

Reports group by exception type and top stack frames, ignoring line numbers
and the bundle id, so one error stays one group across builds. An error thrown
straight in an anonymous function (a timer or promise callback) has a stack
that names no function, so its message is part of the key as well.

## Release health

Release builds on React Native for Vega 0.72 send anonymous foreground sessions
to `/api/release-health` by default. Set `releaseHealth: false` to opt out;
this also best-effort erases the pending health queue without changing crash
reporting. `enabled: false` performs no storage or network work, including erasure.
Debug builds never create or send health records (`debugBuild` overrides `__DEV__`).
Provide an explicit `appVersion` and, optionally, `appBuild`; each must be nonblank,
at most 64 UTF-16 units, with no control or unpaired surrogate characters. Invalid or omitted
versions disable health without changing error reporting.

A session starts only after AppState reports an active component. For multiple
components, any active component keeps the session open; only an all-background
snapshot completes it. Unknown startup or lifecycle state does not create a
completion. The fatal pointer is armed only after the start has been added to
the queue and its storage attempt has finished, leaving a startup monitoring gap.
A fatal ErrorUtils report freezes that pointer and ends monitoring synchronously.
Handled errors, nonfatal ErrorUtils errors and promise rejections do not fail a
session. `setUser` never changes the anonymous health identity. Native crashes,
Hermes aborts, ANRs, forced exits and missing session ends remain unknown.

Health uses the separate AsyncStorage key `@everframe/vega/release-health/v1`,
with at most 100 records and approximately 512 KiB of serialized content;
oldest records are dropped first. Records expire after 7 days or 8 attempts.
Load and writes are serialized, and retries preserve record bytes and IDs.
Automatic retries back off by 2 s, 10 s, 60 s, then 300 s. The endpoint and a
one-way SDK-key fingerprint bind each record; a different endpoint or key on
relaunch discards it. Queue losses are not counted. Health traffic cannot delay
fatal crash persistence or extend the existing 1500 ms fatal-handler handoff.

AsyncStorage and background delivery are best effort: Vega can destroy a
background surface before asynchronous work finishes. Without storage, or when
a write fails, records survive only in memory. Missing AppState, an unavailable
ErrorUtils hook, an invalid version or a debug build disables health delivery;
pending records remain stored until a later eligible launch or explicit opt-out.
React Native 0.83 is not qualified for health. The existing crash-report API
continues to work independently.

## Compatibility

Verified on the Vega Virtual Device with Vega OS 1.1 (React Native 0.72,
Hermes 0.12): install, start, a handled error, an unhandled rejection, fatal
errors from a timer and from React render (stored, delivered on relaunch,
deduplicated), and source-map symbolication. React Native 0.83 on Vega OS 1.2
is untested.

`captureException` details are lighter than in the other SDKs: metadata is
flat, and an error's `cause` chain is not reported (Hermes 0.12 has no
`new Error(message, { cause })`).

## License

MIT
