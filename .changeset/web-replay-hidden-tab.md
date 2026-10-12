---
"@everframe/web": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Web session replay no longer records while the tab is hidden. Hiding the tab stops recording and drops the rolling window. Showing it again starts a fresh recording with a full snapshot.
