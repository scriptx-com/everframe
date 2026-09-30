<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web reporting probe

A fake-key Flutter web integration scene that uses `EverframeWebCapture` and
`EverframeWebBridge` from the Flutter package with the Web SDK reporter.
**Next screen** changes the public tile from green to blue; registered
sensitive content and the HTML platform view are blacked out before pixels
enter the report. `kmp-canvas.html` probes the KMP browser visual provider.

Run `flutter test`, `flutter analyze`, and `flutter build web --release` here. At the public repository root run `EVERFRAME_INGEST_URL=http://127.0.0.1:8938 pnpm --filter @everframe/web... build`. Then run `cd packages/sdk-web && pnpm exec playwright test --config playwright.flutter-probe.config.ts`.

The HTML page refuses an SDK bundle whose ingest URL is not the loopback probe server. Browser checks covered this fixed scene, including its registered HTML platform view; arbitrary platform views and renderers remain unverified. These source additions await package releases.
