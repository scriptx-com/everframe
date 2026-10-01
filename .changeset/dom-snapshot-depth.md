---
"@everframe/protocol": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Adds `MAX_DOM_SNAPSHOT_DEPTH` (1024) and `domSnapshotDepth`, so a page snapshot deeper than a server render accepts can be rejected on the device instead of failing after upload.
