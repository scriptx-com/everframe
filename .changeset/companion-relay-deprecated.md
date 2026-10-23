---
'@everframe/protocol': patch
'@everframe/sdk-core': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

**Deprecated: Everframe Companion has been removed.** In the SDKs every pairing call is now a no-op that logs once: "Everframe Companion has been removed; this call does nothing. Link the device under Settings → Devices in the dashboard and use quick capture." The protocol's `relay` namespace (`relay.RelayMessage` and its branch schemas) and the `relay.v1` JSON Schema stay exported and unchanged, marked deprecated, until the next major version; the Swift and Kotlin relay types are no longer generated. In `@everframe/sdk-core`, `CompanionBadgeServerConfig` and `getCompanionBadgeServerConfig` are deprecated: no SDK declares the `companionbadge` capability or reads the block any more, but the config schema still accepts an optional `companionBadge` so a config from an older server keeps parsing. The `'upgraded'` replay session kind stays accepted; no SDK produces it now that crash-only sessions no longer upgrade. `ReporterTrigger` keeps `'companion'` for reports filed by older builds. The SDKs no longer send the `X-Everframe-Companion-Attribution` header.
