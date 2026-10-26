---
'@everframe/sdk-ios-marker': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

iOS and tvOS: fixed a rare crash (`EXC_BAD_ACCESS` in `_platform_memmove`) while the SDK lists its native-crash, release-health and Apple-diagnostic stores. Each directory entry's name was copied as the full 1024-byte `d_name` field, but `readdir` sizes an entry to its name, so the copy read past the end of the directory buffer. Once a session's crash-context folder held more than about 115 files, every listing read past that buffer, and it crashed when the buffer ended a memory region. Names are now read in place, limited to the entry's own length. Affects 1.1.0 through 1.6.1.
