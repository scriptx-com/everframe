---
"@everframe/cli": patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

Build integrations keep uploading past a single symbol problem instead of stopping at it.

- `everframe elf upload-build --binaries-dir` uploads every library even when the service rejects one, then prints `warning: everframe: upload failed for <path>: …` for each rejection, also with `--summary`. `--strict`, `EVERFRAME_SYMBOLS_STRICT=1` and `--binary` still fail at the first rejection.
- `everframe dsym upload-build` searches each `--dsym-dir` folder on its own in lenient mode: a missing or unreadable folder prints `warning: everframe: skipped <folder>: <code>` and the others are still searched. Strict mode still fails.
- `everframe dsym upload-build --xcode` no longer gives up on the whole upload, including the app's own dSYM, when a symlink loop or a folder it may not read sits in the build products. It skips that entry with a warning and keeps the frameworks it did find. It also warns when the build products search stops at its 16384-entry limit. Strict mode still fails on an unreadable folder.
