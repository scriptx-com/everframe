---
'@everframe/web': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`init({ breadcrumbs: { kinds } })` narrows which kinds the SDK records breadcrumbs for on its own (taps, network, console, navigation, lifecycle, uncaught errors). It is a client veto: the effective set is this list intersected with the dashboard's, so it can turn kinds off for an app whatever the dashboard says, and never turn one on. Breadcrumbs added with `addBreadcrumb` are recorded whatever their kind. An app that shows credentials on buttons or in API paths can now keep tap and network breadcrumbs off in code.
