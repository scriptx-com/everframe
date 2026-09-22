<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @traceitx/protocol

## 0.5.0

### Minor Changes

- fb6e79b: **Report Resource Window: CPU and memory for the last N seconds on every report.**

  Reports and crash envelopes now carry `payload.resources` — CPU and memory
  sampled every 2 seconds over a per-app configurable window (30/60/120s,
  default 60, off by default). Configure it per app in the admin App Overview.
  The admin event drawer charts the window with a peak/average stat row.

  `cpu` is absent on web — no browser CPU API exists; web samples instead carry
  `extras.longTaskMs` / `extras.loopLagMs`.

  Session Vitals is unchanged by this release and keeps stamping `payload.vitals`
  exactly as before.

  The webhook event schema goes `1.1` → `1.2`, additive only:
  `data.report.payload.resources` joins the report payload. Nothing renamed,
  removed, or re-typed, so an existing `1.1` receiver keeps working untouched.

  ## Deploy order — REQUIRED: API before this SDK

  Deploy the API before releasing this SDK version. An API build without
  `payload.resources` in its envelope schema rejects an envelope carrying it
  with a non-retryable 400, and envelope validation is all-or-nothing: the
  **entire bug report or crash report is silently dropped**, not merely its
  resources block, with no error visible to the customer or to you.

  **Minimum required API version:** an API deploy from this repo at or after
  this change merges — one that includes the `resources_enabled` /
  `resource_window_sec` migration, serves the negotiated `resources` config
  block, validates `payload.resources` from this same `@traceitx/protocol`
  release, and delivers webhook schema `1.2`.

- 6f23344: **Playback sessions can now be attributed to the person who was watching.**

  A session carries the end user's identity, through the same two tiers reports
  already use: the verified identity token, or a self-declared `user` block.
  Self-declared identities are shown with an "unverified" badge — the claim rides
  under the publishable SDK key, so it is a claim, never authentication.

  Identity is sent with the session SUMMARY only, never with individual chunks.
  Sessions from SDKs that do not send identity stay anonymous, which is ordinary
  and expected.

  **React Native is not covered by this release.** It is in the same fixed version
  group, so it bumps to the same version, but it gains nothing here: there is no
  JS vitals collector on React Native — `src/vitals.ts` is a thin TurboModule
  forwarder over the native collectors — so parity means adding identity to the
  Android and iOS collectors and their wire codecs. That is separate, and much
  larger, work.

  ## Deploy order — REQUIRED: API before this SDK

  Deploy the API before releasing this SDK version, and apply migration `0091`
  before that API boots.

  The fetch path now sends `X-TX-Identity-Token` on the vitals summary, and that
  header is not in the `Access-Control-Allow-Headers` allow-list of any API build
  predating this change. Omitting a header from that list does **not** merely
  strip the header — it fails the CORS **preflight** outright. So a customer on
  this SDK with verified identity tokens loses the ENTIRE cross-origin summary,
  and the summary is the session row's only source of dims and metrics: the
  sessions go blank, not merely unattributed.

  Customers on the self-declared tier, or sending no identity at all, are
  unaffected — the protocol objects strip unknown keys, so an old API silently
  ignores `user` and `identityToken`.

  Migration `0091` adds `vitals_sessions.reporter_identity_id`. The new API's
  summary INSERT lists that column unconditionally, so booting the new API
  against an un-migrated database fails every summary write.

  **Minimum required API version:** an API deploy from this repo at or after this
  change merges — one with migration `0091` applied, `X-TX-Identity-Token` in the
  vitals CORS allow-list, and the summary-path identity resolution.

## 0.4.0

### Minor Changes

- 4d5554c: **Session Vitals: per-player playback tracking (hls.js, Shaka, and native).**

  `trackPlayer({ element, hls, name })` (and the Shaka/native/custom-integration
  equivalents) attaches per-player identity to Session Vitals: source, DRM,
  bitrate ladder, startup timing breakdown (`manifestMs`/`firstFragmentMs`/
  `licenseMs`), and dropped-frame/quality stats, alongside the phase-3
  element-level play/pause/buffer/seek tracking. `trackVitals(name, data)` logs
  a customer structured entry (session- or player-scoped) onto the session
  timeline. `@traceitx/react` gains `useTrackPlayer`, and the admin Sessions
  tab gains a per-player timeline, a Players panel, and a player-count badge
  inside the session list's existing Integration cell (no new column).

  ## Deploy order — REQUIRED: API before this SDK

  **Deploy the API before releasing this SDK version. This is a hard
  precondition, not a nice-to-have**, and getting the order wrong is worse than
  "vitals are lossy" the way earlier phases could be:
  - An old API rejects a phase-4 `VitalsEntry` (the new `playerId`, `custom`
    entries, and player event types, plus `vitals_sessions.player_count` from
    migration `0082`) with a non-retryable 400. On the **vitals chunk/summary
    path alone**, that is merely a blank vitals timeline for the session — bad,
    but recoverable.
  - It is NOT alone. `stamp-active-vitals.ts` stamps the collector's
    recent-entries ring onto `payload.vitals` on **every bug report and crash
    envelope**, and the envelope validates that field against the exact same
    `VitalsEntry` union. A phase-4 SDK emits a player `stats` entry every 20
    seconds, so almost any session with a player attached has at least one
    entry an old API's narrower union rejects — and envelope validation is
    all-or-nothing. That rejects the **entire report or crash envelope**, not
    just its vitals block: **a customer's bug report or crash report is
    silently dropped**, with no error visible to them or to you.

  **Minimum required API version:** an API build that already includes
  migration `0082` (`vitals_sessions.player_count`) and validates the phase-4
  `VitalsEntry`/`SessionSummary` shapes from this same `@traceitx/protocol`
  release — i.e. any `the ingest API` deploy from this repo at or after this change
  merges. Confirm that build is live in production before publishing this SDK
  version to customers; do not publish it otherwise.

## Unreleased

- Remove retired `payload.uiTree`, `payload.reactTree`, and `payload.reportTarget`
  from the schema and generated native models. This intentionally removes the
  corresponding Swift initializer arguments and legacy payload overloads.
  Unknown historical JSON still parses, but native models do not re-encode it.
  Web rrweb and Android's separate replay format are unchanged.

## 0.3.0

### Minor Changes

- 8159f83: Companion attach now requires device consent: attaching from the dashboard
  shows a 4-digit code on the device (rendered by the SDK by default;
  `attachPinUi: 'custom' | 'off'` to override) that the dashboard member must
  type. Devices on older SDK versions keep one-click attach.
