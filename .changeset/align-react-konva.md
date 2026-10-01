---
"@everframe/web": patch
"@everframe/react": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Fixed the screenshot annotation tool failing to load. It depended on a newer release of the canvas library that requires React 19.3 or later, so it never opened when the bundled or installed React was 19.2. The canvas library is now pinned to the release that matches React 19.2.
