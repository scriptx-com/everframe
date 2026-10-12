// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from "vitest/config";
import { buildConstants } from "./build-constants";

export default defineConfig({
  define: buildConstants(),
  test: { include: ["__tests__/**/*.spec.ts"], environment: "node" },
});
