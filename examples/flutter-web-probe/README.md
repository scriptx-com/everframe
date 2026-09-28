<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Flutter web capture probe

Unreleased, credential-free scene for measuring screenshot, replay, masking, and HTML platform-view behavior. The green public tile becomes blue after **Next screen**; the magenta tile is sensitive and must be redacted before a visual artifact is encoded or stored. The orange tile is an HTML platform view, which is measured separately.

Toolchain used for the first dry run: Flutter 3.47.5 stable, framework revision `6a19cca564`, Dart 3.13.4. The `flutter build web --release` output selects `canvaskit` in its generated loader; `flutter build web --wasm` also compiles successfully. The browser and actual runtime renderer are recorded in the dry-run findings after measurement.

Run `flutter test test/probe_app_test.dart` and `flutter build web --release` from this directory. The probe uses a fake SDK key and a loopback ingest server; it does not submit to Everframe production.
