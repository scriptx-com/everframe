---
"@everframe/cli": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

New `everframe ticket` commands put local images on Everframe tickets from the command line, so a coding agent can file a bug with its screenshots without opening the dashboard. `ticket create --title <text> --attach <image>...` opens a ticket with the images attached, `ticket attach <ticket> <image>...` adds images to an existing ticket, and `ticket comment <ticket> --body <text> --attach <image>...` comments with images. `<ticket>` is a ticket number, a uuid or a dashboard link; a link that carries the project uuid also selects its project, and a link that names the project by its slug needs `--project`. The commands need an API token with the `tickets:write` scope in `EVERFRAME_API_TOKEN`, take the project from `--project` or `EVERFRAME_PROJECT_ID`, retry transient failures safely with an idempotency key, and print the ticket link (or the API response with `--json`).
