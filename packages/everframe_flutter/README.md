<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Everframe Flutter capture core (dry run)

This unreleased package shares masked Flutter render-boundary capture, a sensitive-widget registry that follows layout changes, and a bounded, in-memory safe-frame replay buffer between the web, desktop, Android, and iOS probes. Its narrow Android/iOS method-channel bridge starts the native SDK, passes user/screen/breadcrumb context, and exposes the native reporter. Dart error capture, network hooks, safe-frame attachment to reports, outbox integration, and production support are not implemented. The magenta scan is a test sentinel; every sensitive widget must be registered before reporting real customer content.
