<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter macOS renderer capture probe

Date: 2026-09-28. Public sample revision: `831697ac4be7992e299008dcdba17016959c01a7` on local branch `codex/macos-desktop-probe`. This is the first desktop feasibility slice; desktop support remains **BLOCKED**.

The credential-free sample ran with Flutter 3.47.5 (engine `af7e796e161ae0bb1ff0758c71a7105418bd9ded`), macOS 27.0, and Xcode 27.0. `flutter test` passed 4 widget tests; `flutter test integration_test/desktop_probe_test.dart -d macos` passed one native-device integration test; `flutter analyze`, `flutter build macos`, and `pnpm check:boundary` passed. The test runner printed `Failed to foreground app; open returned 1`, so visible on-screen composition is not independently established by this run.

| Renderer capture capability | Measurement | Result |
| --- | --- | --- |
| Screenshot and A→B transition | Two 800×600 frames; public green and blue inset coverage 1.0 respectively | **PASS** in this fixed scene |
| Sensitive tile masking | Black inset coverage 1.0 in each frame; exporter wrote only after an entire-image magenta scan passed | **PASS** in this fixed scene |
| Embedded AppKit view | Expected orange inset coverage 0 in both renderer frames | Omitted; acceptable if this is optional media, not ordinary app UI |
| Resize, scale, permission, popup, app-window scope | Not measured yet | **BLOCKED / pending** |

The test writes only validated masked PNGs and JSON to the sandbox temporary directory printed as `EVERFRAME_MACOS_PROBE_DIR`. Those files are not committed. The framework-rendered UI and tap transition are present; an omitted optional media surface does not by itself fail the replay gate. Ordinary native controls still need separate evidence. Neither these sample frames nor the build proves reporter, replay delivery, offline outbox, or Windows/Linux support.

## Shared capture follow-up

The sample now uses the unreleased `everframe_flutter` package's sensitive-widget registry. Bounds are read from each registered widget at capture time, and an out-of-bound or unlocatable region refuses capture. A package widget test moved the sensitive tile and verified that the mask followed it. The macOS integration test retained two masked A/B frames through the package recorder; the native run passed. The runner again printed `Failed to foreground app; open returned 1`, so this remains renderer evidence rather than independent visible-window evidence. The package, desktop, and web widget suites and analysis passed. This does not change the desktop support status above.
