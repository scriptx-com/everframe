// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/vite.ts", "src/rollup.ts", "src/webpack.ts", "src/esbuild.ts", "src/next.ts"],
  format: ["esm"],
  external: ["@everframe/cli", "unplugin", "vite", "webpack", "next"],
  dts: true,
  clean: true,
  sourcemap: false,
  target: "node22",
  outDir: "dist",
});
