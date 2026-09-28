<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe Flutter capture core (dry run)

This unreleased package shares masked Flutter render-boundary capture, a sensitive-widget registry that follows layout changes, and a bounded, in-memory safe-frame replay buffer between the web, desktop, Android, and iOS probes. Its Android/iOS bridge starts the native SDK, passes user/screen/breadcrumb context, and opens the native reporter with a freshly captured, masked Flutter PNG. Wrap the screen content in a `RepaintBoundary`, register every sensitive widget with `EverframeSensitive`, and pass that boundary and registry to `openReporter`; missing geometry or capture fails closed. Android hosts must use `FlutterFragmentActivity` for the Compose reporter. Additional reporter screenshots are disabled for the Flutter route.

Dart error capture, network hooks, safe-frame replay attachment to reports, outbox integration, embedded platform-view capture, delivery proof, and production support are not implemented. The magenta scan is a test sentinel; every sensitive widget must be registered before reporting real customer content.
