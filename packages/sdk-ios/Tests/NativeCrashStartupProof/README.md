<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# Installed native startup qualification host

This Release app links the built `EverframeKit` and `EverframeProtocol`
frameworks, calls ordinary `Everframe.shared.start` / `setUser`, and provides
Swift, Objective-C and invalid-memory fault buttons. Automated launches select
`--mode swift|objc|memory|recover|off`, `--key` (synthetic SDK key), `--endpoint`
(explicit HTTP loopback server) and `--nonce` (unique evidence identifier).
Fatal modes terminate after native capture becomes ready; other modes remain
alive for relaunch/retry checks. The host never calls the recovery coordinator.

Generate `project.yml` with `EVERFRAME_PROOF_FRAMEWORKS` pointing to a directory
containing both Release simulator frameworks. Build the generated project with
Xcode's simulator signing enabled and identity `-`. `Proof.entitlements` supplies
only a synthetic simulator application identity/Keychain group. No developer
account, production signing identity or production SDK key is needed.

The host injects a URLProtocol into default session configurations and verifies
that the SDK's actual isolated upload session contains it before starting.
Only ingest requests are forwarded to loopback; other HTTP requests receive a
local response. This exercises unchanged Release SDK routing and request bytes,
not production TLS/service availability. Ready markers and transport traces are
written under Documents; traces contain URL/method/status/byte counts, no headers.
The C readiness probe only observes the linked recorder's enabled state.

Acceptance checks must observe all three process terminations, durable raw and
sealed context records, disabled relaunch retention, original project/user on
recovery under a different configuration, HTTP 503 then successful retry,
receiver deduplication, and no reimport after the queue drains. Use an owned
simulator and synthetic data. tvOS compilation and physical-device qualification
are separate from this iOS installed-app fixture.
