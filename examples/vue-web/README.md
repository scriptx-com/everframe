<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# examples/vue-web

Vue 3 + Vite dogfood app for `@traceitx/web` — the non-React half of the web
SDK's coverage.

The demo is **Elytra**, a small insect field guide ("file a bug about a bug"),
mirroring `examples/react-web` so a report filed from either app is directly
comparable. It is the SUT for the `vue-*` Playwright projects in
`packages/sdk-web`.

## Run it

```bash
pnpm dev:example:vue     # from the repo root
```

The `build:web-sdk` step is not optional: the ingest URL is baked into
`@traceitx/web`'s `dist` at build time, so starting Vite alone against a
release-built dist posts reports to https://traceitx.com.

Then visit http://127.0.0.1:3020 and click **Report a bug**, or press
Cmd/Ctrl+Shift+B. http://127.0.0.1:3020/strict-csp.html is the strict-CSP
fixture. Use `127.0.0.1`, not `localhost`: `vite.config.ts` deliberately binds
`host: '127.0.0.1'` (Vite's unset-host default resolves `localhost` to the
IPv6 loopback `::1` on some machines, which the Playwright webServer probe
cannot reach).

## What each route exercises

| Route | Exercises |
| --- | --- |
| `/` | Seeded PII, both masking surfaces, password input, host-owned trigger |
| `/specimens` | Filterable list — tap crumbs and `aria-label`-derived labels |
| `/specimens/:id` | Detail view, cross-page `localStorage` write |
| `/log` | Add / delete entries — DOM mutation for replay |
| `/settings` | `setUser`, `setExtra`, `kill()` |
| `/strict-csp.html` | A separate document with its own CSP header and `cspNonce` |

`/archive` and `/video` from the React example are deliberately absent: both
test the shared capture core rather than anything the Web SDK does differently.

## e2e invariants

`packages/sdk-web/e2e/vue/` pins these — keep them intact when editing:

- `home-heading` with the literal text `TraceItX Web SDK Example`
- the canonical PII strings under `cc-number` and `bearer-token`
- `password-input` — the `input[type=password]` the SDK's own PRIV-01
  auto-mask picks up; one of the three elements `sensitive-lifecycle.spec.ts`
  counts in the registry
- `sensitive-attr-block` (the attribute surface) and `sensitive-block` (the
  registry surface, via `v-sensitive`) — the second MUST unregister on unmount
- `traceitx-bubble` opens the reporter on `/` and on `/strict-csp.html`
- `nav-home`, `nav-specimens`, `nav-settings`
- `kill-sdk` and `settings-status` on `/settings`
- `strict-csp-heading` on the strict-CSP document

`nav-log` and `csp-marker` exist in the app but nothing in
`packages/sdk-web/e2e/vue/` asserts on them today — they are not pinned
invariants, just markup.

## Known result: 49/51 (WebKit gap, not an SDK defect)

The Vue suite passes chromium 17/17, firefox 17/17, and **webkit 15/17**. The
two WebKit failures are `ingest-submit.spec.ts` and `seeded-pii.spec.ts`, and
they are a **Playwright tooling limitation, not an SDK defect**:

- Real HTTP capture confirms the SDK puts byte-identical bytes on the wire
  under WebKit as it does under Chromium (a real listening server sees
  `total=3403 envelopePart=2037 screenshotPart=1024` on both).
- But `page.route()`'s `request().postDataBuffer()` — the mechanism both
  specs use to inspect the submitted body — returns only a 342-byte skeleton
  with empty parts under WebKit route interception. This matches
  [microsoft/playwright#24077](https://github.com/microsoft/playwright/issues/24077):
  Blob-backed `FormData` is not materialised under WebKit route interception.
- Real Safari users are unaffected — this is an artifact of intercepting the
  request in-process for the test, not of anything the SDK or a real browser
  does on the wire.

**Known fix shape:** point the two body-asserting specs at a real listening
server — `packages/sdk-react/e2e/_fixtures/test-server.ts`'s `startStubIngest`
— instead of `_helpers.ts`'s `postDataBuffer()`-based `stubIngest`, since a
real server sees the real bytes on all three engines. Do not "fix" this by
skipping WebKit for these two specs: that would re-hide the gap this section
exists to document instead of closing it.

## Why Vue, and why not Nuxt

One non-React host proves the framework-agnostic claim; a second adds
maintenance without adding coverage. Vite rather than Nuxt because the claim
under test is the **client-side** lifecycle — `init()` from `onMounted`,
`destroy()` from `onUnmounted`. The SSR guard is pinned by
`packages/sdk-web/__tests__/ssr.spec.ts`.
