<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# examples/react-web

This app demonstrates reporter setup, error capture, identity, source-map build
metadata, and session evidence.

Next.js 16 (app router) dogfood project for `@everframe/react`.

Used by the Phase 3 Playwright e2e suite as the SUT.

The demo is **Elytra**, a small insect field guide ("file a bug about a bug")
— a multi-page app so the reporter has something real to capture: navigation,
interactive lists, generative SVG imagery, forms, and seeded PII.

## Local dogfood

```bash
# Terminal 1 — Everframe ingest service (separate package)
pnpm dev:api

# Terminal 2 — Elytra (rebuilds the web SDK against localhost, then next dev)
pnpm dev:example:web
```

Run both from the repo root. `dev:example:web` shells out to
`pnpm build:web-sdk` before starting Next, because the ingest URL is baked into
`@everframe/react`'s `dist` bundle at build time — starting Next alone against a
release-built dist silently posts reports to `https://everframe.dev`.

Then visit http://localhost:3010 and click the floating **Report a bug**
button (bottom-right corner of every page) or press Cmd/Ctrl+Shift+B.

Visit http://localhost:3010/strict-csp to test the strict-CSP path with `cspNonce`.

## Error button and private source maps

Open **Errors** in the navigation (or `/source-map-check`) and click
**Capture source-map-check**. It throws and catches an error and calls the real
SDK's `captureException`. Find `source-map-check` in this app's dashboard errors.
The page shows the build ID; the button works in development, but verifying
minified stack resolution requires the production workflow below.

Run these commands from the repo root, with your local API running with
`SOURCE_MAP_WORKER_ENABLED=true`:

```bash
# Uses EVERFRAME_KEY_WEB from the repo-root .env, like dev:example:web.
# Use the matching web app UUID from the dashboard.
export EVERFRAME_APP_ID='<web app UUID>'

# Optional: defaults to a fresh web-test-<UUID> on every build.
export EVERFRAME_BUILD_ID='web-test-001'
pnpm --filter examples-react-web build:error-test

# Set EVERFRAME_API_TOKEN in your shell to a token with artifacts:write
# and access to this app's project. Keep this token out of NEXT_PUBLIC_* vars.
pnpm --filter examples-react-web upload:source-maps
pnpm --filter examples-react-web start:error-test
```

Visit **http://localhost:3011/source-map-check** (use `localhost`, not
`127.0.0.1`, because the asset origin is part of source-map matching).
Click the button, open the new error occurrence, and check that the mapped stack
points to `app/(default)/source-map-check/page.tsx`, line 9. Mapping is
asynchronous; refresh the error detail after the worker processes it.

The build command rebuilds the SDK with `http://localhost:8787` as its ingest
origin, then creates a minified Next.js Webpack build with source maps in
`.next-error-test`. Set `EVERFRAME_INGEST_URL` **before building** to use a
different API origin. Upload uses that saved origin plus `/api/v1`; it does
not use `EVERFRAME_API_URL` from your current shell. The SDK key must belong to
the same app UUID and API instance you upload to. The SDK key is read from
`EVERFRAME_KEY_WEB` in the root `.env`. A shell `EVERFRAME_KEY_WEB` takes precedence;
an explicit shell `NEXT_PUBLIC_EVERFRAME_KEY` overrides both. The command reads
only that key from the root file and does not regenerate `.env.local`.

The build ID and API origin are saved with the output. Upload always uses that
saved identity, even if your shell variables later change, and delegates to
the existing Everframe CLI. After the API acknowledges a ready build, the CLI
deletes the public `.map` files. A failed upload keeps them for retry and blocks
preview. Preview starts the same build without rebuilding; ordinary development
continues to use `.next` on port 3010. Do not run another error-test build while
its preview server is running. For another release, stop preview, choose a new
build ID (or unset `EVERFRAME_BUILD_ID` to generate one), then build/upload/start
again.

For a deployed app, CDN, or custom asset origin, follow the source-map
instructions in the Everframe dashboard.

## User recognition (signed identity tokens)

Optional, and off unless configured. When on, reports from this example are
attributed to whichever of the two demo users is currently signed in (see
`UserSwitcher` below) in the dashboard's **People** directory, instead of
arriving anonymous.

1. In the dashboard, open **Project settings → User recognition** (the gear
   beside the project switcher) and **Generate secret**. It is revealed once.
2. Put it and the project id shown beside it in the repo-root `.env`:

   ```
   EVERFRAME_IDENTITY_SECRET=…
   EVERFRAME_IDENTITY_PROJECT_ID=…
   ```

3. Restart `pnpm dev:example:web` — `gen-web-config` projects both into
   `.env.local` (server-only, no `NEXT_PUBLIC_` prefix) and prints
   `user recognition: on`.

Two files make up the demo, one per half of the feature:

- `app/api/everframe-identity/route.ts` — the backend. Uses
  `createIdentityHandler` from `@everframe/identity`; `resolveUser` verifies the
  bearer token from the `Authorization` header. Returns 503 when the signing
  secret is not configured, so the example still reports anonymously.
- `app/components/UserSwitcher.tsx` — a fake two-user session with short-lived
  access tokens. Switching flips both the token and the SDK's `identity.key`,
  which is what fills the dashboard's People directory with two people.

With the vars unset the route returns 503, the SDK's `identity` prop treats
that as "no token" and resolves `null`, and reports submit anonymously —
recognition can never fail or stall a report.

## Routes

- `/` — "Field desk": hero + seeded PII profile (redaction fixtures), `<Sensitive>`,
  password input, phone-companion QR pairing, `useEverframe().open()` button
- `/specimens` — illustrated catalog grid with order filters (click breadcrumbs,
  image capture targets)
- `/specimens/[id]` — specimen detail: facts, a `<Sensitive>` note, and
  "Log an observation" (cross-page localStorage write)
- `/log` — field log: add / confirm / delete entries (DOM mutations for replay)
- `/archive` — long-scroll fixture: ~140 deterministic sighting records under
  sticky month headers, plus a back-to-top jump (scroll capture for replay)
- `/settings` — the rest of the SDK surface: `setUser`, `setExtra`, hotkey info,
  `kill()`
- `/source-map-check` — error trigger and build ID for source-map verification
- `/video` — four `<video>` elements in four readiness states (healthy, stalled,
  cross-origin, bare) plus a layout-fidelity check; the screenshot torture bench
- `/playback` — Session Vitals benches, one page per player source, each with a
  transport strip (play / pause / stop / seek / rate / mute) and, where a library
  sits behind the element, its level or variant picker. Tracking is automatic
  via `useTrackPlayer` — there is nothing to press to start it:
  - `/playback/native` — plain `<video>` over the local clip, no integration
  - `/playback/hls` — hls.js VOD + live through `trackPlayer({ hls })`; Safari
    falls back to native HLS with no integration
  - `/playback/dash` — Shaka Player over DASH through `trackPlayer({ shaka })`
  The HLS/DASH streams are public third-party test streams and will rot;
  override `NEXT_PUBLIC_DEMO_HLS_URL`, `NEXT_PUBLIC_DEMO_HLS_LIVE_URL`, or
  `NEXT_PUBLIC_DEMO_DASH_URL` in the repo-root `.env` (`gen-env-local.sh`
  projects them into `.env.local`).
- `/strict-csp` — minimal fixture under `Content-Security-Policy: default-src 'self';
  script-src 'self' 'nonce-X'; style-src 'self' 'nonce-X'`

## The floating report button

The SDK ships **no visible trigger chrome** — visible triggers are a host-app
concern. `app/components/ReportFab.tsx` is this app's host-owned trigger: a
fixed bottom-right button carrying `data-testid="everframe-bubble"` (the id the
e2e specs click). It styles itself via a CSS module (never inline styles) so it
stays styled under the strict-CSP route, and mounts in both route-group layouts.

## e2e invariants

The Playwright suite (`packages/sdk-react/e2e/`) pins parts of this app —
keep these intact when editing:

- `/` renders `data-testid="home-heading"` with the SSR text
  `Everframe Web SDK Example`, and the page component is named `Home`
- the canonical PII strings under `cc-number` / `bearer-token`, plus
  `sensitive-block` and `password-input`
- companion testids: `companion-section`, `companion-pair-url`, `companion-status`
- `everframe-bubble` opens the reporter on `/` and `/strict-csp`
- `/strict-csp` renders `strict-csp-heading`, `csp-marker`, `cc-number`
