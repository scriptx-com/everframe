---
"@everframe/web": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Screenshots now render with snapDOM, which is several times faster on large pages and keeps the page responsive while capturing. The previous renderer remains as an automatic fallback for one release. A capture that comes out as a flat, single-colour image is now reported with the `screenshot_blank` degraded reason instead of being sent as a normal screenshot.
