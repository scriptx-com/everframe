---
'@everframe/web': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`init()` no longer throws on a page that installs `history.pushState` or `history.replaceState` read-only, as an analytics guard that keeps a tag from hooking them does. Until now it threw part-way through: errors were still reported, but with no breadcrumbs, and the app got no handle to call `kill()` on. A method that can't be patched is now skipped, so navigations through it leave no automatic navigation breadcrumb; back and forward still do, and breadcrumbs added with `addBreadcrumb` are unaffected.
