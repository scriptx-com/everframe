---
"@everframe/web": patch
"@everframe/react": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add `releaseHealth.enabled` to disable automatic page-session health independently of error reporting. Flutter and KMP browser integrations forward this option and reuse the existing page-session collector.
