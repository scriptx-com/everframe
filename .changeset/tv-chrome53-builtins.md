---
"@everframe/sdk-core": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`gzipBytes` no longer reads `globalThis`, so it runs on Chrome 53 smart-TV engines.
