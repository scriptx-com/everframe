---
"@everframe/sdk-android": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Android session replays now keep recording on screens with text fields, video players and sensitive views. Those areas are painted black in the replay instead of the whole frame being dropped, so a replay no longer freezes on the last safe screen. Because such screens are now recorded apart from the masked areas, mark any secret that is also shown outside an input, such as one-time-code digit cells or a card preview. A frame is still skipped when the SDK cannot prove where a sensitive view is drawn: during legacy view animations and layout or shared-element transitions, while the keyboard pans the window, and while a masked area moves. Compose and Flutter windows remain excluded, also in minified release builds. Frames are also no longer dropped just because the app redraws while a frame is being copied (focus moves, spinners), which left Android TV replays almost static.
