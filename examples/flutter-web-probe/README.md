<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web reporting probe

A Flutter web integration scene that uses `EverframeWebCapture` and
`EverframeWebBridge` from the Flutter package with the Web SDK reporter.
**Next screen** changes the public tile from green to blue; registered
sensitive content and the HTML platform view are blacked out before pixels
enter the report. `kmp-canvas.html` probes the KMP browser visual provider.

Run `flutter test --platform chrome`, `flutter analyze`, and `flutter build web --release` here. At the public repository root run `EVERFRAME_INGEST_URL=http://127.0.0.1:8938 pnpm --filter @everframe/web... build`. Then run `cd packages/sdk-web && pnpm exec playwright test --config playwright.flutter-probe.config.ts`. The scene uses a probe key by default; pass `EVERFRAME_SDK_KEY` as a Dart define to send to a local dashboard integration.

The HTML page accepts SDK bundles configured for the loopback probe server or the local dev API on port 8787. Browser checks covered this fixed scene, including its registered HTML platform view; arbitrary platform views and renderers remain unverified.
