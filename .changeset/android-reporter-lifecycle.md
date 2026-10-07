---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Destroying the activity that shows the reporter on Android now closes the reporter and resolves the pending open as cancelled with reason `activity_destroyed`. The report's frozen replay capture is released and the reporter can open again. Previously the open could stay pending, the reporter stayed marked as presenting, and shake-to-report could stay disabled until the app restarted. Backgrounding the app does not close the reporter, and a report that was already sent is not affected. Cancelling the coroutine that opened the reporter after Send no longer strips the session replay, breadcrumbs and network bodies from the report being submitted. The reporter also stays marked as presenting until that report finishes submitting, as it already did for a caller that keeps waiting, so shake-to-report stays disabled during that upload.
