<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/web

Framework-agnostic web SDK for Everframe — AI-ready in-app bug reporting for
any web framework or plain HTML. This is the base every web integration is
built on; `@everframe/react` is a thin React binding on top of it.

MIT · ESM · Node 20+ (build tooling only — the shipped bundles
run in any modern browser)

## Which install do I want?

| Your app | Use |
| --- | --- |
| Has a bundler (Vite, Webpack, Next.js, Nuxt, SvelteKit, Angular CLI, Astro's build) | **ESM install**, below |
| Plain HTML / Rails / Django / WordPress / no bundler at all | **Script tag (CDN)**, below |
| React | [`@everframe/react`](https://www.npmjs.com/package/@everframe/react) — an idiomatic provider + hook over this same core |

Both are ES modules and both produce the identical envelope; they differ only
in what is bundled in. Pick the one that matches your app — see
[The two builds](#the-two-builds) for why they are not interchangeable.

## Install — ESM (bundler apps)

```bash
pnpm add @everframe/web
# or
npm install @everframe/web
```

```ts
import { init } from '@everframe/web';

const everframe = init({
  apiKey: 'txx_live_xxxxxxxxxxxxxxxx',
  appVersion: '1.0.0',
});

// Wire your own trigger — Everframe installs no visible bubble by default,
// only the dashboard-configured hotkey. See "Triggers" below.
document.getElementById('report-bug')?.addEventListener('click', () => {
  everframe.open();
});
```

`dist/index.js` reaches two of its capture dependencies (`modern-screenshot`,
`rrweb`) by a bare dynamic `import()` specifier. A bundler resolves that for
you; a browser loading the file directly via `<script type="module">` cannot,
unless you supply an import map for those two names yourself. In practice:
**if you have a bundler, use this install. If you don't, use the script tag
below** — it is a `<script type="module">` too, but pointed at a build that has
nothing left to resolve. Don't point one at `dist/index.js`.

## Install — script tag (no bundler)

```html
<script type="module">
  import { init } from 'https://cdn.jsdelivr.net/npm/@everframe/web@0.7.0/dist/browser/index.js';

  const everframe = init({
    apiKey: 'txx_live_xxxxxxxxxxxxxxxx',
    appVersion: '1.0.0',
  });
  document.getElementById('report-bug').addEventListener('click', () => {
    everframe.open();
  });
</script>
```

**jsDelivr is the CDN.** It serves every npm package automatically, so
`@everframe/web`'s ordinary `npm publish` *is* the CDN publish — there is no
separate upload, bucket or deploy step. `dist/browser/index.js` is the
package's browser build: same source as the ESM entry, but with every
dependency (React, konva, rrweb, modern-screenshot) inlined, so there is
nothing left for the browser to resolve and no import map to write. It
code-splits, so React and the reporter UI are fetched only if someone actually
opens the reporter.

**Pin an exact version.** This SDK runs on every page of your site and handles
your users' data; `@latest` would auto-deploy a new release to all of your
traffic at once, with no staged rollout and no way to hold it back. Pinned
paths are immutable on jsDelivr and are served with long-lived cache headers.
If you would rather take patches automatically, `@^0.6` is the opt-in — it
resolves to the newest `0.6.x` and updates without a code change.

**One `<script>` block, not two.** `type="module"` is *deferred*: a classic
inline `<script>` after it would run *first*, before `init()` had been called.
Do the `import` and the `init()` in the same module block, as above.

Including the same URL twice (two CMS plugins, a stray duplicate tag) is safe:
the browser's module registry is keyed by URL, so the second one is a no-op and
never evaluates. Two *different* versions on one page are two separate modules,
but `init()`'s own per-page guard catches that too — it warns and hands back
the instance that is already running rather than starting a second, racing SDK.

The tag may go in `<head>` with no `defer` and no `DOMContentLoaded` wrapper —
modules defer by themselves. The ESM entry also tolerates being loaded from a
blocking classic `<script>` in `<head>`, where `<body>` does not exist yet:
`init()` parks its host element on `<html>` and moves it into `<body>` the
instant that element appears, so the handle is still returned synchronously and
the reporter opens normally in between.

## Framework recipes

`@everframe/web` has no framework bindings beyond the plain `init()` call —
each framework recipe below is the same call from that framework's
client-side lifecycle hook. All of these assume the ESM install above.

### Vue

```vue
<script setup>
import { onMounted } from 'vue';
import { init } from '@everframe/web';

onMounted(() => {
  init({ apiKey: 'txx_live_xxxxxxxxxxxxxxxx', appVersion: '1.0.0' });
});
</script>
```

### Svelte

```svelte
<script>
  import { onMount } from 'svelte';
  import { init } from '@everframe/web';

  onMount(() => {
    init({ apiKey: 'txx_live_xxxxxxxxxxxxxxxx', appVersion: '1.0.0' });
  });
</script>
```

### Angular

```ts
import { Component, OnInit } from '@angular/core';
import { init } from '@everframe/web';

@Component({ selector: 'app-root', template: '...' })
export class AppComponent implements OnInit {
  ngOnInit(): void {
    init({ apiKey: 'txx_live_xxxxxxxxxxxxxxxx', appVersion: '1.0.0' });
  }
}
```

### Astro

Plain `<script>` tags inside an `.astro` file already run client-side — Astro
ships them as-is, with no hydration directive needed or accepted. `client:*`
directives are for framework islands (React/Vue/Svelte components) only; an
`.astro` component doesn't render in the browser at all, so passing it one is
a build-time warning, not a way to make it run there:

```astro
---
// src/components/Everframe.astro
---
<script>
  import { init } from '@everframe/web';
  init({ apiKey: 'txx_live_xxxxxxxxxxxxxxxx', appVersion: '1.0.0' });
</script>
```

```astro
<!-- wherever this component is used — no client: directive -->
<Everframe />
```

## SSR hosts (Nuxt, SvelteKit, Astro, Next.js)

`init()` touches `window`, `document` and `localStorage`, so it throws an
actionable error if called where `window` is undefined — i.e. during
server-side rendering:

```
Everframe can only run in a browser. init() touches window, document and
localStorage, so call it from a client-side lifecycle hook — Vue:
onMounted(), Svelte: onMount(), React: useEffect(), Astro: a client:
directive — rather than at module scope in code that is server-rendered.
```

The recipes above are already written this way — `onMounted`, `onMount` and
`ngOnInit` all run client-side only, and a plain `<script>` inside an `.astro`
file is client-side by construction (see the Astro recipe above). The one
thing to avoid is calling `init()` at module scope (top level of a
`.ts`/`.vue`/`.svelte` file that also runs on the server) — the error message
above says "a client: directive" because that's the fix when you're calling
`init()` from inside a React/Vue/Svelte island component's own lifecycle hook,
rather than from a plain `.astro` file's inline script.

`init()` is **idempotent per page**: calling it again while already
initialized logs a warning and returns the existing handle rather than
creating a second instance — safe under hot-reload or a component that
re-mounts.

## The `Everframe` API

`init()` returns a handle with the imperative surface used across every
integration above:

```ts
interface Everframe {
  open(): Promise<ReporterResult>;
  setUser(user: UserMetadata | null): void;
  setIdentityToken(source: IdentityTokenSource): void;
  setExtra(value: string): void;
  addBreadcrumb(input: AddBreadcrumbInput): void;
  captureException(error: unknown): void;
  threads: {
    // Two-way replies — list/read/reply/delete, plus subscribe/refresh for
    // live updates. See EverframeClient['threads'] for the full shape.
    list(): ThreadSummary[];
    get(threadId: string): Promise<ThreadDetail | null>;
    reply(threadId: string, body: string): Promise<void>;
    // …
  };
  kill(): void;
  destroy(): void;
}
```

| Method | What it does |
| --- | --- |
| `open()` | Opens the reporter dialog. Resolves with `{ status: 'submitted' \| 'queued' \| 'cancelled', … }`. Rejects if the handle was destroyed or the reporter isn't mounted. |
| `setUser(user)` | Attaches a user identity to subsequent reports. `null` clears it. |
| `setIdentityToken(source)` | Signed-JWT-based recognition; accepts a token string or a provider function the SDK re-asks as it nears expiry. |
| `setExtra(value)` | Free-form string attached to the next report as host-supplied context. |
| `addBreadcrumb(input)` | Manually record a breadcrumb (`{ message, kind?, level?, data? }`) into the trail every report carries. |
| `captureException(error)` | Reports a caught exception as handled and nonfatal, without opening UI. Uses existing redaction, context, and outbox delivery. |
| `threads` | Two-way replies — list/read/reply to conversations attached to reports from this device. |
| `kill()` | Stops this instance from capturing or submitting anything further; the mounted UI and seams stay in place. A reporter already **open** when this lands is not submitted either: pressing Send discards the report, shows "Reporting is turned off — this report was not sent.", and settles a pending `open()` with `{ status: 'cancelled', reason: 'killed' }`. The same applies to a phone-companion capture or submit in flight. |
| `destroy()` | Full teardown — hotkey, listeners, thread polling, the mounted host element, and the sdk-core client. Safe to call more than once. A host with client-side routing can `init()`/`destroy()` many times per page load without accumulating listeners. |

There is deliberately **no `markSensitive()`** on the handle. `@everframe/react`
exposes a method of that name on its hook, but it has never been wired to
anything — masking is driven entirely by the two surfaces in
[Marking sensitive content](#marking-sensitive-content) below. Rather than
inherit a privacy call that silently does nothing, this handle omits it.

## Reporting caught exceptions

```ts
const everframe = init({
  apiKey: 'txx_live_xxxxxxxxxxxxxxxx',
  appVersion: '2.4.0',
  appBuild: 'web-abc123',
});

try {
  await saveCart();
} catch (error) {
  everframe.captureException(error);
}
```

`captureException()` returns `void`; it does not acknowledge server receipt.
It is a no-op after `kill()`/`destroy()` or when `disabled` or
`crashReporting.disabled` is true. `appBuild` identifies the deployed build in
`context.app.build` on errors and user-filed reports. Source maps are not
processed automatically yet.

The same error object is captured once per SDK instance, with the first
accepted capture determining handled/unhandled classification. Explicit and
automatic capture each have an independent allowance of one report per
fingerprint and ten per SDK instance. Transport retries retain the report ID.

## Triggers

Everframe installs no visible "report a bug" button by default — same
contract as every other Everframe SDK. What `init()` does install:

- **The app's dashboard-configured hotkey**, defaulting to `Cmd/Ctrl+Shift+B`
  (`Mod+Shift+B`). The dashboard value is authoritative; there is no SDK-side
  override.
- A small floating bubble that appears **only once a device has existing
  two-way-reply conversations** (it's an inbox entry point, not a report
  trigger) — nothing shows before that.

A visible "report a bug" trigger is your own UI: call `everframe.open()` from
your own button, menu item, or keyboard shortcut.

## Marking sensitive content

These two surfaces are the **only** things that mask content — there is no
third, programmatic "mark this" call on the handle. There's also no
`<Sensitive>` component outside React: that's a JSX wrapper, and this package
has no JSX. Both surfaces below are equivalent, framework-free, and exercised
by the test suite:

```html
<!-- 1. Mark an element in markup -->
<div data-everframe-sensitive>{value}</div>
```

```ts
// 2. Mark an element programmatically — the same registry React's
// <Sensitive> wrapper calls into, exported directly from this package.
import { sensitiveRegistry } from '@everframe/web';

const el = document.getElementById('credit-card');
sensitiveRegistry.addRef(el);
// later, if the element is removed or should stop being masked:
sensitiveRegistry.removeRef(el);
```

Either way, pixels under that element's rect are blanked at capture time
before the screenshot bytes leave the browser. `<input type="password">`
elements are auto-masked with no action required.

## Component names in reports are React-only

When `@everframe/react` captures a report, it resolves the focused element to
its actual React component name and ancestor path (`CheckoutForm`, not an
anonymous `<div>`) using React's fiber tree. `@everframe/web` has no
framework tree to walk, so a Vue, Svelte, Angular or plain-HTML host's
reports carry **DOM-level** context instead — tag name, CSS selector,
attributes — never a component name. This is inherent to not having a
component tree to read, not a missing feature: there is no workaround for a
non-React host today.

## Companion (TV / phone pairing) and the attach-PIN limitation

`companion.start()` opens the relay connection used for TV/phone-companion
pairing. Its `attachPinUi` option defaults to `'builtin'`, but the built-in
PIN card (`CompanionPinCard`) is rendered only by `@everframe/react`'s
`EverframeProvider` — a vanilla `init()` mount renders the FAB, the reporter
dialog, the inbox and a toast, and nothing else.

**On this package, `'builtin'` silently resolves to `'off'`** rather than
announcing a capability nothing here can show — announcing it anyway would
let the dashboard offer the attach-PIN flow, have a team member spend an
attempt against it, and then have the challenge expire having rendered
nothing. A console warning fires once per page load when this happens.

If you want the attach-PIN flow on a vanilla host, you have to build the UI
yourself:

```ts
// __getCompanionApi is a top-level export, not a member of `companion` —
// despite what the SDK's own console warning for this case says.
import { companion, __getCompanionApi } from '@everframe/web';

companion.start({
  sdkKey: 'txx_live_xxxxxxxxxxxxxxxx',
  attachPinUi: 'custom', // you're taking responsibility for rendering it
});

// Render your own challenge UI from here:
__getCompanionApi().onAttachChallenge((challenge) => {
  // challenge.code (show this), challenge.requestedByName, challenge.ttlMs
});
```

Passing `attachPinUi: 'custom'` without actually rendering something off
that callback is strictly worse than leaving it at the default — it makes
the same false promise `'builtin'` would have. Only pass `'custom'` if you
build the UI.

Note that `__getCompanionApi` carries the double-underscore naming this
package uses for internal seams rather than a settled public name — it's the
only way to reach `onAttachChallenge` today, and it's what the SDK's own
runtime warning points a `'custom'` host at, but treat it as more likely to
move than the rest of this API.

### The companion badge does not render here either

`companion.start()`'s `companionBadge` option (documented as on by default)
configures `CompanionBadge`, the small on-device name badge shown while a
phone or dashboard member is attached. Like the PIN card, that component is
rendered only by `@everframe/react`'s `EverframeProvider`.

It is a harder limitation than the PIN card's, not an oversight: the badge is
an **ambient** surface — it has to be visible while the reporter is *closed* —
and this package's entire ambient footprint is the plain-DOM inbox bubble,
which is exactly what keeps React out of the always-loaded bundle. The badge
lives behind the lazy React island, which is not mounted at the moment the
badge would need to appear.

**So on this package `companionBadge` resolves to OFF**, whatever you pass and
whatever the dashboard sets — the same honest downgrade `attachPinUi:
'builtin'` gets, rather than a setting that reads as configured and shows
nothing. A console warning fires once per page load if you configure the
option explicitly; the default stays silent.

If you want a badge on a vanilla host, render your own:

```ts
import { companion, __getCompanionApi } from '@everframe/web';

companion.start({ sdkKey: 'txx_live_xxxxxxxxxxxxxxxx' });

const api = __getCompanionApi();
api.onAttachedUserName((name) => {
  // name !== null  →  someone is attached; show your badge
});
api.onResolvedName((name) => {
  // the display name to put in it
});
```

## The two builds

| | `dist/index.js` (ESM) | `dist/browser/index.js` (script tag / CDN) |
| --- | --- | --- |
| Always-loaded cost (gzip) | **120.9 KB** | **120.9 KB** |
| Loadable via bare `<script type="module">`? | No — needs a bundler, or an import map for `modern-screenshot` and `rrweb` | Yes — that's the point |
| React, konva, rrweb, modern-screenshot | Left external, for your bundler to fetch lazily | Inlined into the build's own lazy chunks |

Both builds code-split, so React, konva, rrweb and modern-screenshot are
fetched only when someone actually opens the reporter — the always-loaded cost
is the same either way. The difference is only *who resolves the
dependencies*: the ESM entry leaves them to your bundler, and the browser build
has already inlined them, which is what lets a page with no build step load it
from a URL.

**If your app has a bundler, use the ESM install** — it lets your bundler
deduplicate anything you already ship. The script tag exists for the apps that
genuinely have no build step at all, not as a shortcut around adding one.

Until 0.6.6 the script-tag path was an IIFE (`dist/everframe.min.js`), which
cost 391 KB gz because an IIFE has no module loader and therefore cannot
code-split — everything was inlined into the entry. It bought no compatibility
for that: every build here targets es2022, and every browser that can execute
es2022 has supported `<script type="module">` for years. It is gone, and with
it the `window.everframe` global; the named `import` above replaces both.

## Bundling notes

The SDK is ESM-only for the bundler path. `sideEffects: false` is set in
`package.json`, so a bundler configured for tree-shaking sees the always-
loaded entry accurately.

## License

MIT — see `LICENSE` and `NOTICE`.
