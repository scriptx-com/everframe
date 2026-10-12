---
"@everframe/cli": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`everframe setup react-native` lists every file it patched, as `Updated <path>` or `No changes: <path>`. It used to list only changed files, so an app module that was already current did not appear.
