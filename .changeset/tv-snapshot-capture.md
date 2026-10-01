---
"@everframe/web": minor
"@everframe/react": minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Smart-TV web apps can now have their screenshots rendered from a masked page snapshot instead of on the TV, when server-side rendering is enabled for the project: faster, faithful to the TV's fonts, dark mode and focus highlight, and never a blank image. Sensitive elements and input values are masked inside the snapshot, and the snapshot is attached to a report only for screenshots that were not blurred, cropped or area-selected. Companion (phone) reports now always get an answer for a capture request, and can be sent when the TV produced no screenshot. New degraded reasons: `screenshot_render_failed` and `screenshot_unavailable`.
