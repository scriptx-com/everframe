<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web capture probe

Unreleased, credential-free scene for measuring screenshot, replay, masking, and HTML platform-view behavior. The green public tile becomes blue after **Next screen**; the magenta tile is sensitive and must be redacted before a visual artifact is encoded or stored. The orange tile is an HTML platform view, which is measured separately.

Toolchain used for this dry run: Flutter 3.47.5 stable, framework revision `6a19cca564`, Dart 3.13.4. The release build selects CanvasKit in its generated loader; the Wasm build also compiles. Exact revisions and browser measurements are in [the findings](../../docs/dry-runs/flutter-web-capture.md).

From this directory, run `flutter test`, `flutter analyze`, and `flutter build web --release`. From the repository root, build the local SDK with `EVERFRAME_INGEST_URL=http://127.0.0.1:8937 pnpm --filter @everframe/web... build`, then run `cd packages/sdk-web && pnpm exec playwright test --config playwright.flutter-probe.config.ts`. The test starts a loopback server and stores evidence under ignored `packages/sdk-web/test-results/flutter-probe/`.

The sample uses a fake key. `?safe=1` paints the sensitive tile black from the first frame for the stock SDK submission. The **Capture safe frame** button uses a separate renderer capture path that masks the sensitive tile before PNG encoding and exports only that PNG to the browser probe. This is a feasibility probe, not a supported Flutter SDK; the HTML platform view is absent from renderer capture, and stock SDK replay lacks Flutter canvas frames.
