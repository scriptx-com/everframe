---
'@everframe/web': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

`init({ reportRoute })` decides the route an error report carries (`context.route`). It is called when the error is captured, with the page's path at that moment; return a shape (`/invite/:id`) or `null` for no route. By default the path is sent as is. Apps whose URLs carry credentials can now keep them out of error reports, including an error that lands mid-navigation, after the URL changed but before the app rendered the new route. A throwing `reportRoute` sends no route.
