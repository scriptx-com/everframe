<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/react

React (web) SDK for Everframe — AI-ready bug reporting embedded in your app.

MIT · React 18 || 19 · ESM-only · Node 20+

## Install

```bash
pnpm add @everframe/react
# or
npm install @everframe/react
```

Optional but recommended: install the `displayName` preservation plugin so component names survive minification:

```bash
# Babel users (Webpack / CRA / Next.js with Babel config)
pnpm add -D @everframe/babel-plugin-displayname

# SWC users (Next.js default since 12+)
pnpm add -D @everframe/swc-plugin-displayname
```

## Quickstart

Wrap your app once. The Provider mounts the floating bubble, registers the hotkey, and owns the reporter modal lifecycle.

```tsx
// app/layout.tsx (Next.js app router)
import { EverframeProvider } from '@everframe/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <EverframeProvider config={{ sdkKey: 'evf_live_xxxxxxxxxxxxxxxx' }}>
          {children}
        </EverframeProvider>
      </body>
    </html>
  );
}
```

Open the reporter programmatically from anywhere:

```tsx
'use client';
import { useEverframe } from '@everframe/react';

export function HelpButton() {
  const { open } = useEverframe();
  return <button onClick={open}>Report a bug</button>;
}
```

## Reporting caught exceptions

Use `useEverframe().captureException(error)` inside components, or the top-level
export in a catch block or an error boundary:

```tsx
import { captureException } from '@everframe/react';

try {
  await saveCart();
} catch (error) {
  captureException(error);
}
```

Reports are marked handled and nonfatal and use existing redaction, user
context, breadcrumbs, and outbox delivery. The call returns `void`, does not
open UI, and does not acknowledge server receipt. The top-level export is a
no-op without a mounted provider. `kill()`, `disabled`, and
`crashReporting.disabled` also suppress capture.

Configure `appVersion` and `appBuild` on the provider to identify the release
and deployed build. The build is stored as `context.app.build` on errors and
user-filed reports; automatic source-map processing is not available yet.

The same error object is captured once per SDK instance across hook, top-level,
and automatic handlers. The first accepted capture determines classification.
Explicit and automatic capture each allow one report per fingerprint and ten
per SDK instance, independently. Transport retries retain the report ID.

## Errors no boundary catches

When a component throws while rendering, in an effect or in a lifecycle method
and no error boundary inside `EverframeProvider` catches it, React unmounts the
whole tree. The provider reports that error as a fatal crash (`source:
'crash'`, `fatal: true`, mechanism `onerror`), with React's component stack
after the message (`This error is located at:`). No error boundary is needed.
The report is saved to the outbox before it is sent, so a failed send goes out
on the next page load.

The provider then hands the same error on unchanged: an error boundary of yours
around the provider still catches it, and otherwise React reports it to the
page, where the SDK recognises it and does not report it again. Errors that a
boundary inside the provider catches are not reported automatically; call
`captureException` from that boundary's `componentDidCatch`. A React 18
development build reports a failed render or effect to `window.onerror` before
any boundary sees it, so in development such an error can arrive as a non-fatal
error, instead of or as well as the fatal report.

`tests/render-error-browser.mjs` checks this in Chromium against real React
roots, production and development builds:

```sh
node tests/render-error-browser.mjs /tmp/render-error-proof
node tests/render-error-browser.mjs /tmp/render-error-proof-18 --react-root <dir with react@18 installed>
```

## Release health observations

Opt in independently of replay and vitals:

```tsx
<EverframeProvider config={{
  sdkKey: 'your-sdk-key',
  releaseHealth: { enabled: true, loadedBuildId: 'the-build-actually-loaded' },
}}>
  {children}
</EverframeProvider>
```

Capture starts after the Provider mounts. Configuration is frozen for that
mount; remount with a new React `key` when the loaded build, SDK key or
`releaseHealth.userId` changes, including on login, logout and account switch.
Rerenders do not rotate the exposure. Normal unmount queues an end and retains
offline records for the next opted-in mount at the same destination. Calling
`useEverframe().kill()` or mounting with explicit disabled consent purges that
destination's health queue. No health storage or requests start by default.

Observations are anonymous unless you pass `releaseHealth.userId`, a
project-local opaque account ID (omit it on logout). `setUser`, recognition and
replay sessions never supply it. It must be nonblank, at most 128 UTF-16 units
and free of U+0000–U+001F control characters and unpaired surrogates. An invalid
ID leaves release health unavailable for that mount: nothing is recorded or sent.
Starts and ends do not prove healthy execution; a missing end does not prove a
crash. Crash-free rates are unavailable, and user counts cover only supplied IDs.
Durable storage is required; there is no in-memory fallback. The existing web
journal bounds records across tabs and preserves the original build through
retries. These are version 2 records: the receiving service must support
version 2 before you enable them. See
[release health observations](../../docs/release-health.md).

## Triggers

By default the SDK installs:

- **The app's dashboard-configured hotkey**, defaulting to `Cmd/Ctrl+Shift+B`
  (`Mod+Shift+B`). The dashboard value is authoritative; there is no SDK-side
  override.

`Mod` resolves to `Cmd` on macOS and `Ctrl` elsewhere.

A visible trigger (bubble, menu item, etc.) is the host app's responsibility — call `useEverframe().open()` from your own button to bring up the reporter.

## Strict-CSP environments

If your app sets a strict CSP (`script-src 'self' 'nonce-...'`), thread the nonce into the SDK so screenshot capture's dynamically-injected styles are accepted:

```tsx
// Next.js: read the nonce from headers() in your layout
import { headers } from 'next/headers';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? '';
  return (
    <EverframeProvider config={{ sdkKey: 'evf_live_xxxxxxxxxxxxxxxx', cspNonce: nonce }}>
      {children}
    </EverframeProvider>
  );
}
```

## Marking sensitive content (PRIV-02)

Three equivalent surfaces — pick whichever fits your codebase:

```tsx
import { Sensitive, useEverframe } from '@everframe/react';
import { useEffect, useRef } from 'react';

// 1. Component wrapper
<Sensitive><CreditCardNumber /></Sensitive>

// 2. data-attribute (works on any DOM element)
<div data-everframe-sensitive>{value}</div>

// 3. Ref hook
function MyField({ value }: { value: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { markSensitive } = useEverframe();
  useEffect(() => {
    if (ref.current) markSensitive(ref);
  }, [markSensitive]);
  return <div ref={ref}>{value}</div>;
}
```

All three resolve to the same internal sensitive-rect registry; pixels under those rects are blanked at capture time before the screenshot bytes leave the device.

## Bundling notes

The SDK is ESM-only. Some Next.js + monorepo setups need to transpile workspace packages:

```ts
// next.config.ts
transpilePackages: ['@everframe/react', '@everframe/sdk-core', '@everframe/protocol'],
```

The always-loaded entry measures ~136 KB gzip (`pnpm size-limit`, budget 240 KB). The heavy capture and annotation dependencies — rrweb, react-konva, and modern-screenshot — are lazy-imported and are not in that number; they load only when the reporter is actually opened.

## Example

See [`examples/react-web/`](https://github.com/scriptx-com/everframe/tree/main/examples/react-web) for a Next.js dogfood project covering both the strict-CSP fixture and the standard SSR fixture.
