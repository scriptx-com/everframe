---
"@everframe/web": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Smart-TV engines down to Chrome 53 (webOS 4):
- The SDK loads again: a regular expression using lookbehind and Unicode property escapes no longer stops the module from loading.
- Reports with a focused element are no longer rejected: the focus position is read from `left`/`top`.
- The TV snapshot path no longer uses `trimEnd`, `globalThis` or `padStart`.
- On weak TV profiles, pages above 1,000 elements skip the page snapshot instead of freezing the app for seconds, and the snapshot scrub is faster on pages that repeat styles.
