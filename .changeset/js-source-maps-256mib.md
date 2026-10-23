---
'@everframe/protocol': minor
'@everframe/cli': minor
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

JavaScript source maps (web, Hermes and Vega) may be up to 256 MiB each (from 32 MiB), and a web build's maps up to 1 GiB together (from 256 MiB). Release React Native maps had grown past 32 MiB, so `build collect` and `sourcemaps upload-hermes` failed with `source_map_too_large`. The CLI now streams every source map from a private snapshot and sends it gzip-compressed when the server lists `gzip` in `uploadEncodings`. Upload these maps only to an Everframe API that accepts the larger limit.
