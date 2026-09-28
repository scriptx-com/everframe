<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web capture feasibility dry run

Date: 2026-09-28. Status: **BLOCKED** for Flutter web support. This is an unreleased local probe, not a Flutter SDK or an end-to-end reporting integration.

## Revisions and setup

- Public probe code: `6e4880669634c2d83df3c6ce43196f9ef34ecca5` on local branch `codex/flutter-web-probe`; public base `fb5be19`. The stock browser SDK is `@everframe/web` 0.9.0, built from this checkout with `EVERFRAME_INGEST_URL=http://127.0.0.1:8937`.
- Flutter 3.47.5 stable, framework `6a19cca56475dbfba1478ee68d7bd0c2ef891da1`, engine `af7e796e161ae0bb1ff0758c71a7105418bd9ded`, Dart 3.13.4. JS release output selected CanvasKit. Wasm compiled, but this browser measurement used the JS release build.
- Playwright Chromium 153.0.8010.12, viewport 1280×720 at device scale 1. The sample uses a fake key; observed Everframe API origin was only `http://127.0.0.1:8937`.

## Measured capabilities

| Path | Screenshot | Sensitive tile | Replay / HTML platform view |
| --- | --- | --- | --- |
| Current Web SDK | **PASS**: 1280×720, blue public tile coverage 0.978 | **BLOCKED**: magenta coverage 0.978, black coverage 0 | **BLOCKED**: replay attachment exists, but 0 canvas frames |
| Sample renderer capture | **PASS**: two distinct 1280×720 frames show green then blue tile on an opaque white background | **PASS in this fixed sample**: black coverage 1.0 in both frames; 0 magenta pixels in either PNG | **BLOCKED**: orange HTML platform view coverage 0; replay was not integrated |

The stock screenshot placed the magenta tile at `(33,133,158,78)` while Flutter's logical tile is `(40,140,160,80)`. A mask placed at the nominal coordinates on the stock DOM screenshot could leave sensitive edges exposed. The renderer path masks in its own logical coordinate space before PNG encoding; it must still gain safe HTML platform-view handling and visual replay before it can become an adapter.

## Privacy and artifacts

The unsafe stock screenshot was measured in browser memory only. The stock submission used a separate `?safe=1` scene whose sensitive tile was black from its first frame; its saved screenshot was checked for zero magenta pixels. The renderer probe exports only PNGs after masking; both saved frames were checked for zero magenta pixels. No real key or production endpoint was used.

The ignored local artifacts are `packages/sdk-web/test-results/flutter-probe/stock-evidence.json`, `renderer-evidence.json`, `safe-submit.png`, `renderer-a.png`, and `renderer-b.png`. They are reproducible and are not committed. A green measurement test means the measurements ran; **BLOCKED** entries remain product failures.

## Reproduction and next seam

Run `flutter test`, `flutter analyze`, `flutter build web --wasm`, and `flutter build web --release` in `examples/flutter-web-probe`; then run `EVERFRAME_INGEST_URL=http://127.0.0.1:8937 pnpm --filter @everframe/web... build` at the public root. Run `pnpm exec playwright test --config playwright.flutter-probe.config.ts` in `packages/sdk-web`, followed by `pnpm --filter @everframe/web typecheck` and `pnpm check:boundary` at the root. The observed run passed 4 Flutter tests, 7 Chromium tests, analysis, both builds, typecheck, and boundary check.

The next public adapter needs a screenshot provider and visual replay frame provider at the Web SDK report boundary. It must resolve sensitive Flutter regions and HTML platform views into safe visual artifacts before encoding or submission, and fail closed when that cannot be proved. A later Flutter web dry run must also verify real reporter annotation, retry, metadata, and dashboard delivery against a development environment before the target can pass the program gate.
