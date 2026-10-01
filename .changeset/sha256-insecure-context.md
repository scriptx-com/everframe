---
"@everframe/web": patch
"@everframe/react": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Screenshots, page snapshots and session-replay attachments now work on pages served over plain `http://` (common for hosted smart-TV apps). Their SHA-256 digests fall back to a built-in implementation when the browser's Web Crypto `crypto.subtle` is unavailable, instead of failing the capture.
