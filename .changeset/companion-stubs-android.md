---
'@everframe/sdk-android': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

**Deprecated: Everframe Companion has been removed.** The documented Companion API stays as deprecated no-op stubs, so apps that follow the docs keep compiling. Pairing calls do nothing: the first `Everframe.startCompanion()` in a process logs one warning, "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture.", and no socket, announce or timer is ever started. `Everframe.companion`'s flows hold their idle values forever (`state` is `CompanionState.Unpaired`; `pairUrl`, `code`, `attachedUserName`, `resolvedName` and `attachChallenge` are `null`), `Everframe.stopCompanion()` does nothing, and the `companionDeviceId`, `companionBadgeEnabled` and `companionBadgePosition` `EverframeConfig` parameters keep their positions and are ignored. These APIs are deleted at the next major version.

The SDK no longer sends the `X-Everframe-Companion-Attribution` header or declares the `companionbadge` capability; a config that still carries a `companionBadge` block decodes and the block is ignored. Crash-only sessions (`reporterEnabled = false`) no longer upgrade when a phone pairs. `ReporterTrigger.Companion` stays for reports filed by older builds.

Kept, deprecated: `Everframe.companion` (`dev.everframe.companion.Companion`), `AttachChallengeInfo`, `CompanionState`, `Everframe.startCompanion()` and `Everframe.stopCompanion()`. The quick-capture submit pipeline moved from `dev.everframe.companion.CompanionSubmissionComposer` to `dev.everframe.quickcapture.SubmissionComposer`, with the same API minus `companionAttribution`.

Removed (undocumented plumbing):

- `RelayWSClient` and `AttachPinUi`
- `CompanionBadge`, `CompanionBadgeLabel`, `CompanionBadgeOptions`, `CompanionBadgePosition`, `parseCompanionBadgePosition`, `parseCompanionBadgePositionOrNull` and `CompanionBadgeServerConfigSignal`
- `AnnounceDevice`, `CompanionDeviceId` and `CompanionDeviceFacts`
- `PreviewCapture`, `NormalizedRect`, `PreviewStopReason`, `CompanionPreviewSession` and `CompanionPreviewSessionApi`, and `ScreenshotCapture.capturePreviewFrame(...)`
- `CompanionCaptureBridge`
- `dev.everframe.companion.CompanionSubmissionComposer` (now `dev.everframe.quickcapture.SubmissionComposer`)
- `Everframe.__registerCompanionClient`, `__unregisterCompanionClient`, `__attachPinUiInstalled` and `__attachPinUiSuppressed`
- the `companionAttribution` parameter of `MultipartUploader.upload(...)` and `ReportSubmitter.submit(...)`
- the generated relay types in `dev.everframe.protocol.generated` (`RelayMessage`, `PairCreated`, `ReportSubmit`, `ReportAssembled` and their siblings)
