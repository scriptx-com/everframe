---
'@everframe/sdk-ios-marker': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

**Deprecated: Everframe Companion has been removed.** The documented Companion API stays as deprecated no-op stubs, so apps that follow the docs keep compiling. Pairing calls do nothing: the first `RelayWSClient.connect()` in a process logs one warning, "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.", and no socket, announce or timer is ever started. `Everframe.shared.companion` is always `.unpaired` with `pairUrl`, `code`, `attachedUserName`, `resolvedName` and `attachChallenge` all `nil`, and the `everframeCompanion*` notifications are never posted. `CompanionCaptureBridge(client:)` and `CompanionPinPresenter.install()` do nothing, and the `companionDeviceId`, `companionBadgeEnabled` and `companionBadgePosition` `EverframeConfig` parameters are accepted and ignored. These APIs are deleted at the next major version.

The SDK no longer sends the `X-Everframe-Companion-Attribution` header or declares the `companionbadge` capability; a config that still carries a `companionBadge` block parses and the block is ignored. Crash-only sessions (`reporterEnabled: false`) no longer upgrade when a phone pairs. `ReporterTrigger.companion` stays for reports filed by older builds.

Kept, deprecated: `CompanionAPI` (`state`, `pairUrl`, `code`, `attachedUserName`, `resolvedName`, `attachChallenge`, `__setBuiltinPinUiSuppressed(_:)`), `CompanionState`, `CompanionAttachChallenge`, the `Notification.Name.everframeCompanion*` constants, `AttachPinUi`, `CompanionBadgeOptions`, `CompanionBadgePosition`, `RelayWSClient` (its convenience initializer, `connect()`, `disconnect()`), `CompanionCaptureBridge(client:)` and `CompanionPinPresenter.install()`.

Removed (undocumented plumbing):

- `RelayWSClient.send(_:)`, `sendBinary(_:)`, `backoffSchedule`, its test seams and its `URLSessionWebSocketDelegate` conformance
- `CompanionBadge`, `CompanionBadgeLabel` and `CompanionBadgeResolution`
- `AnnounceDevice`
- `CompanionAuthEpoch`, `PreviewStopReason`, `NormalizedRect`, `CompanionPreviewSessionApi` and `CompanionPreviewSession`
- `PreviewCapture`, `ScreenshotCapture.capturePreviewFrame(...)`, `ScreenshotCapture.PREVIEW_MAX_EDGE_PT` and `ScreenshotCapture.PREVIEW_QUALITY`
- `CompanionCaptureBridge.shouldAttachReactTreeNotification` and its `__*ForTesting` seams
- `CompanionAPI.__builtinPinUiInstalled` and `__builtinPinUiSuppressed`
- the `companionAttribution` parameter of `ReporterSubmission.Inputs`, `MultipartUploader.upload(...)` and `ReportSubmitter.submit(...)`
- the `upgraded` parameter of `NetworkBodyCaptureGate.locallyDisabled(for:)`
- `EverframeProtocol`'s generated relay types (`EverframeRelayMessage`, `EverframePairCreated`, `EverframeReportSubmit`, `EverframeReportAssembled` and their siblings)
