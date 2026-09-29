<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web reporting dry run

Date: 2026-09-29. Status: **local reporter and ingest pass; launch blocked**. This is an unreleased probe with a fake key and a loopback endpoint.

## Current result

The Flutter renderer now owns the report screenshot and replay pixels. `captureRegisteredFrame` masks registered sensitive widgets before encoding a PNG; `SafeReplayRecorder` retains validated frames in a bounded memory buffer. The Web SDK's `visualCapture` provider receives those PNGs, and its reporter submits the screenshot plus an `everframe-vtree-v1` image replay. When a provider frame is missing or malformed, screenshot capture rejects without attempting DOM capture. When a visual provider has no replay source, rrweb is disabled instead of recording Flutter's DOM wrapper. Reports use `everframe-flutter` identity.

The sample registers its HTML platform view as a sensitive region, so it is blacked out in the screenshot and every replay asset. This fixed scene does not establish that arbitrary platform views or custom renderers are registered and masked correctly.

Chromium on the 1280×720 probe submitted a report through the Web SDK reporter to `http://127.0.0.1:8938`. The multipart body contained a protocol-valid envelope, screenshot, and VTree replay with at least two distinct image assets showing the green and blue screens. Attachment hashes and lengths matched. The sensitive and platform-view tile interiors were over 99% black, with zero magenta pixels in the submitted screenshot and replay assets. Every observed API request stayed on loopback. A second browser test forced an ingest 503, then confirmed the queued report retried with the same report ID and attachment refs. Nine Chromium probe tests and four Web SDK host-capture unit assertions passed. Flutter's five widget tests, analysis, and JS release build passed; the release build's Wasm dry run also passed.

## Baseline and remaining checks

The earlier stock `@everframe/web` path captured the wrong coordinates for Flutter's sensitive tile and produced an rrweb attachment with no Flutter canvas frames. That browser measurement was made on 2026-09-28; its unsafe PNG remained in browser memory and was never saved or submitted. The old stock submission used a separate black-from-first-frame scene. The new visual provider replaces that path for this probe.

Before release, verify moving and overlapping sensitive widgets, other embedded HTML platform views, annotations, durable retry across browser restarts, metadata, browser variants, and real backend/dashboard playback in a development environment. This local test does not prove those paths. No package was published or production endpoint contacted.

## Reproduce

Use Flutter 3.47.5 and Dart 3.13.4. In `examples/flutter-web-probe`, run `flutter test`, `flutter analyze`, and `flutter build web --release`. At the public repository root run `EVERFRAME_INGEST_URL=http://127.0.0.1:8938 pnpm --filter @everframe/web... build`. In `packages/sdk-web`, run `pnpm exec playwright test --config playwright.flutter-probe.config.ts`, followed by `pnpm typecheck`. The browser test starts its own loopback server on port 8938; it never contacts the private platform.
