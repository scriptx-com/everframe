<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed native startup qualification host

This Release app links the built `EverframeKit` and `EverframeProtocol`
frameworks, calls ordinary `Everframe.shared.start` / `setUser`, and provides
Swift, Objective-C, invalid-memory and `abort()` fault buttons. Automated launches
select `--mode swift|objc|memory|abort|recover|off`, `--key` (synthetic SDK key), `--endpoint`
(explicit HTTP loopback server) and `--nonce` (unique evidence identifier).
Fatal modes terminate after native capture becomes ready; other modes remain
alive for relaunch/retry checks. The host never calls the recovery coordinator.

Generate `project.yml` with `EVERFRAME_PROOF_FRAMEWORKS` pointing to a directory
containing both Release simulator frameworks. One target builds for the iOS
simulator (`-sdk iphonesimulator`) or the tvOS simulator (`-sdk appletvsimulator`)
from the matching framework slice. Build the generated project with
Xcode's simulator signing enabled and identity `-`. `Proof.entitlements` supplies
only a synthetic simulator application identity/Keychain group. No developer
account, production signing identity or production SDK key is needed.

The host injects a URLProtocol into default session configurations and verifies
that the SDK's actual isolated upload session contains it before starting.
Only ingest requests are forwarded to loopback; other HTTP requests receive a
local response. This exercises unchanged Release SDK routing and request bytes,
not production TLS/service availability. Ready markers and transport traces are
written under `Library/Caches`, because tvOS apps cannot write Documents; traces
contain URL/method/status/byte counts, no headers.
The C readiness probe only observes the linked recorder's enabled state.

Acceptance checks must observe every fault's process termination, durable raw and
sealed context records, disabled relaunch retention, original project/user on
recovery under a different configuration, HTTP 503 then successful retry,
receiver deduplication, and no reimport after the queue drains. Use an owned
simulator and synthetic data. tvOS has no Mach exception detector or alternate
signal stack, so this host has no stack-overflow fault. Physical-device
qualification is separate from this simulator fixture.
