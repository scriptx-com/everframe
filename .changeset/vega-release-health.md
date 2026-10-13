---
"@everframe/vega": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Add anonymous foreground release-health sessions for native Vega apps. Fatal JavaScript reports carry their frozen session identity; handled errors, non-fatal rejections and unsupported native process failures do not lower the crash-free rate. Preserve browser Vega page sessions and respect debug and collection opt-outs.
