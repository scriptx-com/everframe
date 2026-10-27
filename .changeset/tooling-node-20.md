---
'@everframe/cli': patch
'@everframe/bundler-plugin': patch
'@everframe/metro': patch
'@everframe/expo': patch
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2026 ScriptX -->

The build tooling now supports Node 20: `@everframe/cli`, `@everframe/bundler-plugin`, `@everframe/metro` and `@everframe/expo` declare `node >=20` instead of `>=22`. Nothing in them needed Node 22, but the stricter range made `yarn install` fail outright on Node 20 projects that added one of them, as Yarn 1 enforces `engines` by default.
