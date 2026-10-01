<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter macOS capture probe

This credential-free macOS feasibility sample tests whether a Flutter renderer frame includes an embedded AppKit view. It paints a public tile green on screen A and blue on screen B, a magenta sensitive tile, and an orange native AppKit view. The mask is applied in memory before PNG encoding. The exporter refuses to write any PNG containing magenta pixels.

Run `flutter test`, `flutter analyze`, and `flutter build macos`. Run `flutter test integration_test/desktop_probe_test.dart -d macos` for a live macOS capture. The integration test prints a temporary artifact directory containing only validated masked frames and pixel measurements. No report or network request is sent.

The result is a capture feasibility measurement, not a desktop SDK or a support claim.
