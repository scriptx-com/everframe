<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->
# Release health qualification host

This isolated Release framework consumer exercises opt-in anonymous iOS segments,
actual fatal termination and normal relaunch. Pass an explicit synthetic SDK key
and loopback HTTP endpoint. The host intercepts both default and ephemeral URL
sessions, forwards only ingest paths, and rejects other network destinations.
Modes are `fatal`, `recover`, `off`, and `health-only`. Replay, vitals, logs and
installation identifiers are disabled. This fixture does not represent physical
device coverage or MetricKit attribution.

The host uses the scene life cycle, which apps built with the iOS and tvOS 27
SDKs need to launch on 27 runtimes; the SDK still starts in the app delegate.
One target builds for the iOS simulator (`-sdk iphonesimulator`) or the tvOS
simulator (`-sdk appletvsimulator`) from the matching framework slice in
`EVERFRAME_PROOF_FRAMEWORKS`. Ready markers and transport traces go to Documents
on iOS and to `Library/Caches` on tvOS, which cannot write Documents.
