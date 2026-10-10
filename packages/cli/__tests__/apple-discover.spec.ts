// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { dirname } from "node:path";
import { collectAppleBuild } from "../src/apple-build.js";
import { discoverAppBundle, linkedFrameworks, resolveArchiveSource, resolveXcodeSource } from "../src/apple-discover.js";
import { appBundle, dsym, macho, universal } from "./apple-build-fixture.js";

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

/** A 64-bit Mach-O header with LC_UUID and one LC_LOAD_DYLIB per name. */
function linking(uuid: string, names: string[], kind = 2): Buffer {
  const base = macho({ uuid, kind });
  const commands = names.map((name, i) => {
    const text = Buffer.from(name + "\0");
    const size = Math.ceil((24 + text.length) / 8) * 8;
    const command = Buffer.alloc(size);
    command.writeUInt32LE(i % 2 ? 0x80000018 : 0xc, 0);
    command.writeUInt32LE(size, 4);
    command.writeUInt32LE(24, 8);
    text.copy(command, 24);
    return command;
  });
  const out = Buffer.concat([base, ...commands]);
  out.writeUInt32LE(1 + names.length, 16);
  out.writeUInt32LE(24 + commands.reduce((n, c) => n + c.length, 0), 20);
  return out;
}
const POD_A = "aaaaaaaa-0000-4000-8000-000000000001",
  POD_B = "bbbbbbbb-0000-4000-8000-000000000002",
  HERMES = "cccccccc-0000-4000-8000-000000000003",
  UNUSED = "dddddddd-0000-4000-8000-000000000004";
async function put(path: string, bytes: Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
  return path;
}
/**
 * React Native with use_frameworks!: the app links pod frameworks that
 * "[CP] Embed Pods Frameworks" has not copied into the bundle yet. Each pod
 * builds into its own configuration build dir with its dSYM beside it.
 */
async function podsLayout() {
  const root = await temp();
  const b = await appBundle(root);
  await writeFile(b.executable, linking("01234567-89ab-cdef-0123-456789abcdef", [
    "@rpath/PodA.framework/PodA",
    "@rpath/Feature.framework/Feature",
    "@rpath/hermesvm.framework/hermesvm",
    "/System/Library/Frameworks/UIKit.framework/UIKit",
    "@rpath/libswiftCore.dylib",
  ]));
  const podA = await put(join(root, "PodA", "PodA.framework", "PodA"), linking(POD_A, ["@rpath/PodB.framework/PodB"], 6));
  const podB = await put(join(root, "PodB", "PodB.framework", "PodB"), universal([macho({ uuid: POD_B, kind: 6 })]));
  const hermes = await put(
    join(root, "XCFrameworkIntermediates", "hermes-engine", "Pre-built", "hermesvm.framework", "hermesvm"),
    macho({ uuid: HERMES, kind: 6 })
  );
  await put(join(root, "Unused", "Unused.framework", "Unused"), macho({ uuid: UNUSED, kind: 6 }));
  await dsym(join(root, "PodA"), "PodA.framework", macho({ uuid: POD_A, kind: 10 }));
  await dsym(join(root, "PodB"), "PodB.framework", macho({ uuid: POD_B, kind: 10 }));
  await dsym(join(root, "Unused"), "Unused.framework", macho({ uuid: UNUSED, kind: 10 }));
  await dsym(root, "App.app", macho({ kind: 10 }));
  return { root, b, podA, podB, hermes };
}
it("reads run-path framework links from thin and universal Mach-O files", async () => {
  const f = await podsLayout();
  expect(await linkedFrameworks(f.b.executable)).toEqual(["Feature.framework", "PodA.framework", "hermesvm.framework"]);
  expect(await linkedFrameworks(f.podA)).toEqual(["PodB.framework"]);
  expect(await linkedFrameworks(f.podB)).toEqual([]);
  expect(await linkedFrameworks(join(f.root, "missing"))).toEqual([]);
});
it("adds the pod frameworks the app links but has not embedded yet, transitively, and nothing unlinked", async () => {
  const f = await podsLayout();
  const resolved = await resolveXcodeSource(xcodeEnv(f.root, { DWARF_DSYM_FOLDER_PATH: f.root }));
  expect(resolved.kind === "source" && resolved.source.binaries).toEqual([
    { path: f.b.executable, required: true },
    { path: f.b.framework, required: false },
    { path: f.b.extension, required: true },
    { path: f.podA, required: false },
    { path: f.hermes, required: false },
    { path: f.podB, required: false },
  ]);
});
it("uploads pod framework dSYMs from their per-pod build dirs and reports the prebuilt one without a dSYM", async () => {
  const f = await podsLayout();
  const resolved = await resolveXcodeSource(xcodeEnv(f.root, { DWARF_DSYM_FOLDER_PATH: f.root }));
  if (resolved.kind !== "source") throw new Error("expected a source");
  const build = await collectAppleBuild({ ...resolved.source, lenient: true });
  expect(build.images.map((image) => image.uuid).sort()).toEqual(["01234567-89ab-cdef-0123-456789abcdef", POD_A, POD_B].sort());
  expect(build.uncovered.map((entry) => entry.path)).toEqual(expect.arrayContaining([f.hermes]));
  expect(build.images.some((image) => image.uuid === UNUSED)).toBe(false);
});
