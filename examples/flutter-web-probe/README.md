<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web reporting probe

An unreleased, fake-key Flutter scene that connects masked renderer PNGs and a bounded image replay to the Web SDK reporter. **Next screen** changes the public tile from green to blue; registered sensitive content and the HTML platform view are blacked out before pixels enter the report.

Run `flutter test`, `flutter analyze`, and `flutter build web --release` here. At the public repository root run `EVERFRAME_INGEST_URL=http://127.0.0.1:8938 pnpm --filter @everframe/web... build`. Then run `cd packages/sdk-web && pnpm exec playwright test --config playwright.flutter-probe.config.ts`.

The HTML page refuses an SDK bundle whose ingest URL is not the loopback probe server. [Dry-run evidence and remaining gates](../../docs/dry-runs/flutter-web-capture.md) cover the browser measurements. This sample is not a released Flutter web SDK.
