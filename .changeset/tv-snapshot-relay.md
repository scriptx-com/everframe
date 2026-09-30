---
"@everframe/protocol": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Companion relay frames can now describe a capture that produced no image: `report.assembled` gains an optional `outcome` (`image`, `snapshot` or `unavailable`), `degraded_reason` and a snapshot reference, and `report.submit` gains per-shot `has_image` and redaction state so a device only waits for the images that will actually arrive. Existing frames are unchanged and still valid.
