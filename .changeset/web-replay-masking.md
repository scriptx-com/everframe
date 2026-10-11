---
"@everframe/web": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Web session replay now masks before anything leaves the browser, for bug reports and error replays alike. Every form input value is masked, and checkbox, radio and select state is not recorded. Elements marked sensitive (`data-everframe-sensitive`, `<Sensitive>` or `sensitiveRegistry`) are blocked, including ones that appear after recording starts. Card numbers, JWTs, bearer tokens, US SSNs and email addresses are removed from all recorded text and attributes. Other page text stays readable. Until now web replay recorded text and input values raw.
