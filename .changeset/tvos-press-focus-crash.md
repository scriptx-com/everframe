---
"@everframe/sdk-ios-marker": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Fix a tvOS crash on the first remote press in apps that use scene-based focus. The press breadcrumb read `UIScreen.focusedView`, which UIKit refuses with "screen-based focus unsupported"; it now reads the focused view from the window's focus system.
