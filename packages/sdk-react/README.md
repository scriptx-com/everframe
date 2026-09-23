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
import { TraceItXProvider } from '@everframe/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <TraceItXProvider config={{ apiKey: 'txx_live_xxxxxxxxxxxxxxxx' }}>
          {children}
        </TraceItXProvider>
      </body>
    </html>
  );
}
```

Open the reporter programmatically from anywhere:

```tsx
'use client';
import { useTraceItX } from '@everframe/react';

export function HelpButton() {
  const { open } = useTraceItX();
  return <button onClick={open}>Report a bug</button>;
}
```

## Reporting caught exceptions

Use `useTraceItX().captureException(error)` inside components, or the top-level
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

## Triggers

By default the SDK installs:

- **The app's dashboard-configured hotkey**, defaulting to `Cmd/Ctrl+Shift+B`
  (`Mod+Shift+B`). The dashboard value is authoritative; there is no SDK-side
  override.

`Mod` resolves to `Cmd` on macOS and `Ctrl` elsewhere.

A visible trigger (bubble, menu item, etc.) is the host app's responsibility — call `useTraceItX().open()` from your own button to bring up the reporter.

## Strict-CSP environments

If your app sets a strict CSP (`script-src 'self' 'nonce-...'`), thread the nonce into the SDK so screenshot capture's dynamically-injected styles are accepted:

```tsx
// Next.js: read the nonce from headers() in your layout
import { headers } from 'next/headers';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const nonce = (await headers()).get('x-nonce') ?? '';
  return (
    <TraceItXProvider config={{ apiKey: 'txx_live_xxxxxxxxxxxxxxxx', cspNonce: nonce }}>
      {children}
    </TraceItXProvider>
  );
}
```

## Marking sensitive content (PRIV-02)

Three equivalent surfaces — pick whichever fits your codebase:

```tsx
import { Sensitive, useTraceItX } from '@everframe/react';
import { useEffect, useRef } from 'react';

// 1. Component wrapper
<Sensitive><CreditCardNumber /></Sensitive>

// 2. data-attribute (works on any DOM element)
<div data-traceitx-sensitive>{value}</div>

// 3. Ref hook
function MyField({ value }: { value: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { markSensitive } = useTraceItX();
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
