---
"@everframe/web": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Fix `@everframe/react` ignoring reporter branding and companion state. The `@everframe/web/ui` entry kept its own copies of the branding and companion stores, so the React reporter dialog never picked up the dashboard theme, the `theme` option or the watermark setting, and the companion badge and PIN card never saw a running companion session. `/ui` now reads these stores from the main `@everframe/web` entry, so there is one instance of each on the page.
