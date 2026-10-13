---
"@everframe/roku": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add anonymous release health for Roku OS 13+ launches with the updated host exit bridge. Preserve exact previous-session ownership, count only confirmed BrightScript/native crash exits, and keep resource/system exits separate. Deliver through a bounded durable queue independently from crash-report throttles, with debug exclusion and health-only opt-out. Reduce the crash-report queue to four entries to reserve registry room for health.
