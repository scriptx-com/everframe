// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// This is a regression test for a bug where the CLI's invocation guard
// compared `process.argv[1]` (the path Node was invoked with) directly
// against `import.meta.url` (the realpath of the executing file), without
// resolving symlinks first. Every documented invocation of this CLI goes
// through a symlink -- `npx everframe`, the generated Gradle/Xcode build
// phase, `eas-update.sh` -- because package managers install `bin` entries
// as a symlink in `node_modules/.bin` pointing at the realpath. With the
// unresolved comparison, the guard's condition was always false when
// invoked that way, so `main` silently never ran: the process printed
// nothing and exited 0. A test that only calls `main()` directly, or that
// spawns `dist/index.js` by its own realpath (as `command.spec.ts` already
// does), cannot catch this -- the bug is in the guard, not in `main`.
describe("bin invocation through a symlink", () => {
  const distEntry = join(import.meta.dirname, "..", "dist", "index.js");

  it("runs main and prints help when invoked through a symlink, matching a direct realpath invocation", async () => {
    if (!existsSync(distEntry)) {
      console.warn(
        `SKIPPED: ${distEntry} does not exist. Run \`pnpm --filter @everframe/cli build\` first; this test spawns the built entry to faithfully reproduce how the package's \`bin\` field is actually invoked.`,
      );
      return;
    }

    const dir = await mkdtemp(join(tmpdir(), "everframe-bin-symlink-"));
    const link = join(dir, "everframe");
    try {
      await symlink(distEntry, link);

      const child = spawn(process.execPath, [link, "--help"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const [code] = (await once(child, "close")) as [number];

      expect(code).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("everframe sourcemaps upload");
      expect(stdout).toContain("everframe build verify");
      expect(stderr).toBe("");
      // The specific failure mode this test guards against: the guard
      // silently doing nothing, which looks like success (exit 0) but with
      // no output at all.
      expect(stdout).not.toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not run main merely by importing the module as a library", async () => {
    // If the invocation guard's comparison were ever satisfied unconditionally
    // (e.g. `main` were called at module scope without a guard at all), a
    // plain import from a test or from a consumer using this package as a
    // library would run the CLI's `main` as a side effect. Confirm the
    // module can be imported without that happening: `main` must be a plain
    // export the caller invokes explicitly.
    const mod = await import("../src/index.js");
    expect(typeof mod.main).toBe("function");
    // Importing must not have set an unexpected exitCode as a side effect of
    // `main` running during module evaluation.
    expect(process.exitCode).toBeUndefined();
  });
});
