// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { discoverAppBundle, resolveArchiveSource, resolveXcodeSource } from "../src/apple-discover.js";
import { appBundle, macho } from "./apple-build-fixture.js";

const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "everframe-apple-discover-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
function xcodeEnv(root: string, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    TARGET_BUILD_DIR: root,
    WRAPPER_NAME: "App.app",
    WRAPPER_EXTENSION: "app",
    EXECUTABLE_PATH: "App.app/App",
    DWARF_DSYM_FOLDER_PATH: join(root, "dsyms"),
    BUILT_PRODUCTS_DIR: root,
    CONFIGURATION: "Release",
    DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
    ...overrides,
  };
}

it("requires app and extension executables and treats embedded frameworks as optional", async () => {
  const b = await appBundle(await temp());
  expect(await discoverAppBundle(b.app)).toEqual([
    { path: b.executable, required: true },
    { path: b.framework, required: false },
    { path: b.extension, required: true },
  ]);
});
it("falls back to every root-level Mach-O when the executable is not named after the bundle", async () => {
  const app = join(await temp(), "My App.app");
  await mkdir(app);
  await writeFile(join(app, "MyApp"), macho());
  await writeFile(join(app, "Info.plist"), "<plist/>");
  expect(await discoverAppBundle(app)).toEqual([{ path: join(app, "MyApp"), required: true }]);
});
it("rejects a path that is not an app bundle", async () => {
  await expect(discoverAppBundle(join(await temp(), "Missing.app"))).rejects.toThrow(/^invalid_app_bundle: /);
});
it("resolves an Xcode Release build to the bundle and both symbol folders", async () => {
  const root = await temp();
  const b = await appBundle(root);
  expect(await resolveXcodeSource(xcodeEnv(root))).toEqual({
    kind: "source",
    source: {
      binaries: [
        { path: b.executable, required: true },
        { path: b.framework, required: false },
        { path: b.extension, required: true },
      ],
      dsymDirs: [join(root, "dsyms"), root],
    },
  });
});
it("uses EXECUTABLE_PATH when it differs from the bundle name", async () => {
  const root = await temp();
  await appBundle(root);
  await rename(join(root, "App.app", "App"), join(root, "App.app", "Runner"));
  const resolved = await resolveXcodeSource(xcodeEnv(root, { EXECUTABLE_PATH: "App.app/Runner" }));
  expect(resolved.kind === "source" && resolved.source.binaries[0]).toEqual({
    path: join(root, "App.app", "Runner"),
    required: true,
  });
});
it.each([
  [{ CONFIGURATION: "Debug" }, /^Debug configuration/],
  [{ DEBUG_INFORMATION_FORMAT: "dwarf" }, /^DEBUG_INFORMATION_FORMAT is dwarf; set it to dwarf-with-dsym/],
])("skips %o with its reason", async (overrides, reason) => {
  const root = await temp();
  await appBundle(root);
  const resolved = await resolveXcodeSource(xcodeEnv(root, overrides));
  expect(resolved.kind).toBe("skip");
  expect(resolved.kind === "skip" ? resolved.reason : "").toMatch(reason);
});
it("refuses a sandboxed Run Script up front, after the Debug skip", async () => {
  const root = await temp();
  await appBundle(root);
  await expect(resolveXcodeSource(xcodeEnv(root, { ENABLE_USER_SCRIPT_SANDBOXING: "YES" }))).rejects.toThrow(
    /^xcode_script_sandboxed: .*Set ENABLE_USER_SCRIPT_SANDBOXING = NO/
  );
  expect((await resolveXcodeSource(xcodeEnv(root, { ENABLE_USER_SCRIPT_SANDBOXING: "YES", CONFIGURATION: "Debug" }))).kind).toBe("skip");
});
it("uploads Debug symbols only when asked", async () => {
  const root = await temp();
  await appBundle(root);
  const resolved = await resolveXcodeSource(xcodeEnv(root, { CONFIGURATION: "Debug", EVERFRAME_UPLOAD_DEBUG: "1" }));
  expect(resolved.kind).toBe("source");
});
it("rejects missing Xcode variables and non-app targets", async () => {
  await expect(resolveXcodeSource({})).rejects.toThrow(/^xcode_environment_missing: /);
  await expect(
    resolveXcodeSource(xcodeEnv(await temp(), { WRAPPER_EXTENSION: "framework", WRAPPER_NAME: "Feature.framework" }))
  ).rejects.toThrow(/^xcode_target_not_app: /);
});
it.skipIf(process.getuid?.() === 0)("explains a sandboxed Run Script phase", async () => {
  const root = await temp();
  const b = await appBundle(root);
  await chmod(join(b.app, "Frameworks"), 0o000);
  try {
    await expect(resolveXcodeSource(xcodeEnv(root))).rejects.toThrow(
      /^xcode_script_sandboxed: Xcode denied access to .+\. Set ENABLE_USER_SCRIPT_SANDBOXING = NO/
    );
  } finally {
    await chmod(join(b.app, "Frameworks"), 0o755);
  }
});
it("resolves an archive to its single app and its dSYMs folder", async () => {
  const archive = join(await temp(), "App.xcarchive");
  const b = await appBundle(join(archive, "Products", "Applications"));
  await mkdir(join(archive, "dSYMs"));
  const source = await resolveArchiveSource(archive);
  expect(source.dsymDirs).toEqual([join(archive, "dSYMs")]);
  expect(source.binaries[0]).toEqual({ path: b.executable, required: true });
});
it("rejects archives without exactly one app or without dSYMs", async () => {
  const archive = join(await temp(), "App.xcarchive");
  await mkdir(join(archive, "Products", "Applications"), { recursive: true });
  await expect(resolveArchiveSource(archive)).rejects.toThrow(/^archive_app_not_found: .*\(found 0\)/);
  await appBundle(join(archive, "Products", "Applications"));
  await expect(resolveArchiveSource(archive)).rejects.toThrow(/^archive_dsyms_missing: /);
});
