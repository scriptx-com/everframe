<!-- SPDX-License-Identifier: MIT -->

## 1.1.0

### Minor Changes

- b90da7c: <!-- SPDX-License-Identifier: MIT -->
    <!-- SPDX-FileCopyrightText: 2026 ScriptX -->
  Envelopes carry `context.app.debug` when the SDK detects a debug build, and release-health records move to schema version 5 with a required `app.debug`. Everframe never creates a release from a debug build.
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

# @everframe/roku

## 1.0.0

### Minor Changes

- 08c011a: <!-- SPDX-License-Identifier: MIT -->
  <!-- SPDX-FileCopyrightText: 2026 ScriptX -->

  New Roku SDK: ComponentLibrary crash reporting (next-launch exit detection on Roku OS 13+), manual `captureException`, and the `everframe-roku instrument` build step that wraps entry points in try/catch without changing line numbers.
