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
companion mode on Vega OS.

## Install

```sh
npm install @everframe/vega
```

At the top of `index.js`, before `AppRegistry.registerComponent`:

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
EVERFRAME_API_TOKEN=… npx everframe sourcemaps upload-vega \
  --app-id <app id> --dir build/lib/rn-bundles/Release
```

The Vega CLI names each bundle by its SHA-256 and writes
`<id>.bundle.map` next to it. Every report carries that id, so a map uploaded
for one build never applies to another. Debug builds load the bundle from
Metro and are not mapped.

## API

| Call | |
| --- | --- |
| `init(config)` | Start the SDK. Call once; later calls are ignored. |
| `captureException(error, options?)` | Report a caught error. `options`: `severity` (`info`, `warning`, `error`), `context` (a label), `metadata` (flat: strings, numbers, booleans, null). |
| `setUser(user \| null)` | `{ id?, email?, displayName? }` on later reports. |
| `addBreadcrumb({ message, kind?, level?, data? })` | The latest 100 breadcrumbs ride on every report. |
| `flush()` | Resolves after stored reports were sent once. |
| `getStatus()` | `{ enabled, bundleId, rejections, pending }`. |

## Configuration

| Key | Default | |
| --- | --- | --- |
| `sdkKey` | required | Your Vega integration's SDK key. Without it the SDK stays off. |
| `storage` | none | AsyncStorage, or any object with `getItem` and `setItem`. |
| `appName` | `Vega app` | Shown on reports. |
| `appVersion` | `0.0.0` | Your app version. |
| `appBuild` | none | A build number or CI build id. |
| `captureUnhandledRejections` | `true` | `false` stops reporting promise rejections. |
| `device` | none | `{ model, osVersion }`, e.g. from `@amazon-devices/react-native-device-info`. React Native for Vega does not expose them to JavaScript. |
| `enabled` | `true` | `false` turns the SDK off. |
| `endpoint` | `https://everframe.dev` | For self-testing only. |

Dashboard settings (session replay, vitals, network bodies and the like) do
not apply: the SDK does not fetch server config.

## How delivery works

Reports are JSON `POST`s to `/api/ingest`; Vega OS networking drops
multipart bodies. Each report is stored before it is sent, retried with
backoff while the app runs and on the next launches (up to 8 attempts or 7
days), and removed once the server accepts or permanently rejects it. A resend
carries the same report id, so the server stores it once. At most 10 reports
wait at a time; non-fatal ones are dropped first.

Per launch, the same automatic error from the same place is reported once,
and at most 10 distinct automatic and 10 distinct handled errors are
reported. Fatal errors are always reported.

## Compatibility

Verified against Vega OS 1.1 (React Native 0.72, Hermes 0.12) in Vega's
bundler. React Native 0.83 on Vega OS 1.2 is not verified yet.

## License

MIT
