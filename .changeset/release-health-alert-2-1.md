---
'@everframe/protocol': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The `release_health.threshold_reached` webhook moves to event schema 2.1. A release now also alerts when one of its platforms is below the crash-free target on its own, even if the total passes. `data.platforms` lists the platforms the dashboard shows (`ReleaseHealthTargetSchema`, which adds `xbox`), and the new `data.belowTargetPlatforms` lists each breaching platform with its session counts and `crashFreeSessions`. `RELEASE_HEALTH_ALERT_SCHEMA_VERSION` is now `'2.1'`, and `ReleaseHealthTargetSchema` and `ReleaseHealthBelowTargetPlatformSchema` are new. A receiver pinned to schema 2.0 must upgrade: 2.1 events fail a strict 2.0 parse. Every other webhook event stays at 1.2.
