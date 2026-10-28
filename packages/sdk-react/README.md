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
`captureException` from that boundary's `componentDidCatch`, with React's
component stack so the error page says which components it happened in:
`captureException(error, { componentStack: info.componentStack })`. A React 18
development build reports a failed render or effect to `window.onerror` before
any boundary sees it, so in development such an error can arrive as a non-fatal
error, instead of or as well as the fatal report.

`tests/render-error-browser.mjs` checks this in Chromium against real React
roots, production and development builds:

```sh
node tests/render-error-browser.mjs /tmp/render-error-proof
node tests/render-error-browser.mjs /tmp/render-error-proof-18 --react-root <dir with react@18 installed>
```

## Triggers

By default the SDK installs:

- **The app's dashboard-configured hotkey**, defaulting to `Cmd/Ctrl+Shift+B`
  (`Mod+Shift+B`). The dashboard value is authoritative; there is no SDK-side
  override.

`Mod` resolves to `Cmd` on macOS and `Ctrl` elsewhere.

A visible trigger (bubble, menu item, etc.) is the host app's responsibility — call `useEverframe().open()` from your own button to bring up the reporter.

To report crashes and errors without letting users file reports, set
`reporter: { disabled: true }` in the provider config. That session has no
hotkey, no replies button or inbox, and `open()` rejects with
`EverframeReporterDisabledError`. Session replay uses the app's crash-only
sampling rate (0 by default) and network bodies stay off. See
[crash-only sessions](../../docs/session-replay.md#crash-only-sessions).

### Samsung and LG TVs

On a Samsung Tizen or LG webOS TV, the provider sets up device linking and the
remote capture gesture the same way `@everframe/web` does. Pass
`debugBuild: true` for debug builds and `quickCapture: { disabled: true }` to
turn it off. See
[Quick capture on Samsung and LG TVs](../sdk-web/README.md#quick-capture-on-samsung-and-lg-tvs).

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
