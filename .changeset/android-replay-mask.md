---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android session replays now keep recording on screens with text fields, video players and sensitive views. Those areas are painted black in the replay instead of the whole frame being dropped, so a replay no longer freezes on the last safe screen. Frames are also no longer dropped when the app redraws while a frame is being copied (focus moves, scrolling, spinners), which left Android TV replays almost static.
