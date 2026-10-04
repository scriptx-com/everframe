// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // protocol is private: true and never reaches npm, so its types and code
  // are inlined (see sdk-react-native/tsup.config.ts for why dts needs resolve).
  dts: { resolve: ["@everframe/protocol"] },
  clean: true,
  sourcemap: false,
  target: "node22",
  outDir: "dist",
  noExternal: ["@everframe/protocol", "zod"],
});
