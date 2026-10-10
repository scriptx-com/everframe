// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectAndroidElfBuild, discoverElfBinaries } from "../src/elf-build.js";
import { elfUploadBuildCommand } from "../src/elf-command.js";
import type { uploadAndroidElfBuild } from "../src/elf-upload.js";
import { elfFixture } from "./elf-build-fixtures.js";

const APP_ID = "00000000-0000-4000-8000-000000000002";
const OWN = "aa".repeat(20),
  PREBUILT = "bb".repeat(20);
const NO_TOKEN =
  "warning: everframe: no EVERFRAME_API_TOKEN, skipping symbol upload. Crashes from this build will show raw addresses. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
/** AGP layout: stripped_native_libs/…/lib/<abi>/*.so ships, merged_native_libs/…/lib/<abi>/*.so keeps debug info. */
async function agp() {
  const root = await mkdtemp(join(tmpdir(), "everframe-elf-command-"));
  roots.push(root);
  const shipped = join(root, "stripped", "lib"),
    symbols = join(root, "merged", "lib");
  for (const dir of [shipped, symbols])
    for (const abi of ["arm64-v8a", "x86_64"]) await mkdir(join(dir, abi), { recursive: true });
  const app = join(shipped, "arm64-v8a", "libapp.so"),
    hermes = join(shipped, "x86_64", "libhermes.so");
  await writeFile(app, elfFixture({ id: OWN, sections: false }));
  await writeFile(join(symbols, "arm64-v8a", "libapp.so"), elfFixture({ id: OWN }));
  await writeFile(hermes, elfFixture({ machine: 62, id: PREBUILT, sections: false }));
  await writeFile(join(symbols, "x86_64", "libhermes.so"), elfFixture({ machine: 62, id: PREBUILT, debug: false }));
  return { root, shipped, symbols, app, hermes };
}
function recorder(failure?: Error) {
  const upload = vi.fn<typeof uploadAndroidElfBuild>(async () => {
    if (failure) throw failure;
    return { artifacts: [], images: [], uncovered: [], failed: [] };
  });
  const lines: string[] = [],
    warnings: string[] = [];
  return { upload, lines, warnings, deps: { upload, log: (l: string) => lines.push(l), warn: (l: string) => warnings.push(l) } };
}

it("discovers every shipped library in the AGP lib/<abi> layout", async () => {
  const f = await agp();
  expect(await discoverElfBinaries(f.shipped)).toEqual([f.app, f.hermes]);
});
it("uploads own libraries and reports prebuilt stripped ones instead of failing", async () => {
  const f = await agp();
  const build = await collectAndroidElfBuild({
    binaries: [
      { path: f.app, required: true },
      { path: f.hermes, required: false },
    ],
    symbolsDir: f.symbols,
  });
  expect(build.artifacts).toHaveLength(1);
  expect(build.images).toEqual([{ buildId: OWN, abi: "arm64-v8a" }]);
  expect(build.uncovered).toEqual([
    { path: f.hermes, kind: "prebuilt", reason: `prebuilt without debug information (build ID ${PREBUILT}, x86_64)` },
  ]);
});
it("names the ABI, build ID and path of each required library without symbols", async () => {
  const f = await agp();
  await expect(
    collectAndroidElfBuild({ binaries: [{ path: f.hermes, required: true }], symbolsDir: f.symbols })
  ).rejects.toThrow(new RegExp(`^missing_matching_elf: .*\\n  x86_64 ${PREBUILT} in .*libhermes\\.so$`));
});
it("reports an optional non-ELF file and fails a required one", async () => {
  const f = await agp();
  const junk = join(f.shipped, "arm64-v8a", "libjunk.so");
  await writeFile(junk, "not an elf");
  const build = await collectAndroidElfBuild({
    binaries: [
      { path: f.app, required: true },
      { path: junk, required: false },
    ],
    symbolsDir: f.symbols,
  });
  expect(build.uncovered).toEqual([{ path: junk, kind: "not_an_image", reason: "no GNU build ID or not a shared library" }]);
  await expect(collectAndroidElfBuild({ binaries: [{ path: junk, required: true }], symbolsDir: f.symbols })).rejects.toThrow(
    "invalid_elf_binary"
  );
});
/** The project's own CMake output: libnative.so built without debug information, as with -g0 or -s. */
async function ownStripped(f: Awaited<ReturnType<typeof agp>>) {
  const OWN_STRIPPED = "cc".repeat(20);
  const shipped = join(f.shipped, "arm64-v8a", "libnative.so"),
    cxx = join(f.root, "cxx", "RelWithDebInfo", "obj", "arm64-v8a");
  await mkdir(cxx, { recursive: true });
  await writeFile(shipped, elfFixture({ id: OWN_STRIPPED, sections: false }));
  await writeFile(join(f.symbols, "arm64-v8a", "libnative.so"), elfFixture({ id: OWN_STRIPPED, debug: false }));
  await writeFile(join(cxx, "libnative.so"), elfFixture({ id: OWN_STRIPPED, debug: false }));
  return { id: OWN_STRIPPED, shipped, project: join(f.root, "cxx") };
}
it("reports the project's own libraries without debug information apart from prebuilt ones", async () => {
  const f = await agp();
  const own = await ownStripped(f);
  const binaries = [
    { path: f.app, required: false },
    { path: f.hermes, required: false },
    { path: own.shipped, required: false },
  ];
  const build = await collectAndroidElfBuild({ binaries, symbolsDir: f.symbols, projectDirs: [own.project] });
  expect(build.uncovered).toEqual([
    { path: f.hermes, kind: "prebuilt", reason: `prebuilt without debug information (build ID ${PREBUILT}, x86_64)` },
    {
      path: own.shipped,
      kind: "no_debug_info",
      reason: `built by this project without debug information (build ID ${own.id}, arm64-v8a); build it with -g (CMake: RelWithDebInfo) and do not strip it before packaging`,
    },
  ]);
  // Without the project's native output folders every stripped library counts as prebuilt.
  const unknown = await collectAndroidElfBuild({ binaries, symbolsDir: f.symbols });
  expect(unknown.uncovered.map((entry) => entry.kind)).toEqual(["prebuilt", "prebuilt"]);
  // A missing project folder never fails the upload.
  const missing = await collectAndroidElfBuild({ binaries, symbolsDir: f.symbols, projectDirs: [join(f.root, "absent")] });
  expect(missing.uncovered.map((entry) => entry.kind)).toEqual(["prebuilt", "prebuilt"]);
});
it("passes the project's native output folders through and warns about its stripped libraries with the fix", async () => {
  const f = await agp();
  const own = await ownStripped(f);
  const r = recorder();
  r.upload.mockImplementation(async (options) => {
    const build = await collectAndroidElfBuild({ binaries: options.binaries, symbolsDir: options.symbolsDir, projectDirs: options.projectDirs });
    return { artifacts: [], images: build.images, uncovered: build.uncovered, failed: [] };
  });
  const env = { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID };
  const args = ["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, "--project-native-dir", own.project];
  expect(await elfUploadBuildCommand(args, env, r.deps)).toBe(0);
  expect(r.upload.mock.calls[0]![0].projectDirs).toEqual([own.project]);
  expect(r.warnings).toEqual([
    `warning: no symbols for ${own.shipped}: built by this project without debug information (build ID ${own.id}, arm64-v8a); build it with -g (CMake: RelWithDebInfo) and do not strip it before packaging; its frames stay raw.`,
  ]);
  expect(r.lines).toContain("1 prebuilt library ships without debug information; their frames stay raw: libhermes.so");
  const summary = recorder();
  summary.upload.mockImplementation(r.upload.getMockImplementation()!);
  expect(await elfUploadBuildCommand([...args, "--summary"], env, summary.deps)).toBe(0);
  expect(summary.lines).toContain(
    `detail: no_debug_info ${own.shipped}: built by this project without debug information (build ID ${own.id}, arm64-v8a); build it with -g (CMake: RelWithDebInfo) and do not strip it before packaging`
  );
});
it("accepts more than sixteen libraries by default", async () => {
  const f = await agp();
  const binaries = [{ path: f.app, required: true }];
  for (let i = 0; i < 20; i++) {
    const path = join(f.shipped, "arm64-v8a", `libvendor${i}.so`);
    await writeFile(path, elfFixture({ id: (i + 16).toString(16).padStart(2, "0").repeat(20), sections: false }));
    binaries.push({ path, required: false });
  }
  expect((await collectAndroidElfBuild({ binaries, symbolsDir: f.symbols })).uncovered).toHaveLength(20);
});
it("does not warn about prebuilt libraries without debug information, and names them once", async () => {
  const f = await agp();
  await rm(f.app);
  const r = recorder();
  r.upload.mockImplementation(async (options) => {
    const build = await collectAndroidElfBuild({ binaries: options.binaries, symbolsDir: options.symbolsDir });
    return { artifacts: [], images: build.images, uncovered: build.uncovered, failed: [] };
  });
  const env = { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID };
  expect(await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols], env, r.deps)).toBe(0);
  expect(r.warnings).toEqual([]);
  expect(r.lines).toContain("1 prebuilt library ships without debug information; their frames stay raw: libhermes.so");
});
it("only considers the ABIs a variant packages", async () => {
  const f = await agp();
  const r = recorder();
  const env = { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID };
  expect(await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, "--abi", "arm64-v8a"], env, r.deps)).toBe(0);
  expect(r.upload.mock.calls[0]![0].binaries).toEqual([{ path: f.app, required: false }]);
  const none = recorder();
  expect(await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, "--abi", "armeabi-v7a"], env, none.deps)).toBe(0);
  expect(none.upload).not.toHaveBeenCalled();
  expect(none.lines).toEqual([`No native libraries under ${f.shipped} for armeabi-v7a; nothing to upload.`]);
  await expect(elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, "--abi", "mips"], env, r.deps)).rejects.toThrow(/^invalid_abi: mips/);
});
it("prints one detail line per library without symbols in summary mode and no warnings", async () => {
  const f = await agp();
  const r = recorder();
  r.upload.mockResolvedValue({
    artifacts: [],
    images: [],
    uncovered: [
      { path: f.hermes, kind: "prebuilt", reason: "prebuilt without debug information (build ID x, x86_64)" },
      { path: f.app, kind: "missing", reason: "no unstripped library with build ID y (arm64-v8a) under z" },
    ],
    failed: [],
  });
  const env = { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID };
  expect(await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, "--summary"], env, r.deps)).toBe(0);
  expect(r.warnings).toEqual([]);
  expect(r.lines).toEqual([
    "Symbols for 0 images are ready (0 ELF files).",
    `detail: prebuilt ${f.hermes}: prebuilt without debug information (build ID x, x86_64)`,
    `detail: missing ${f.app}: no unstripped library with build ID y (arm64-v8a) under z`,
  ]);
});
it("discovers libraries for the command, keeps them optional and prints warnings", async () => {
  const f = await agp();
  const r = recorder();
  r.upload.mockResolvedValue({ artifacts: [], images: [], uncovered: [{ path: f.hermes, kind: "missing", reason: "no unstripped library" }], failed: [] });
  const code = await elfUploadBuildCommand(
    ["--binaries-dir", f.shipped, "--symbols-dir", f.symbols],
    { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID },
    r.deps
  );
  expect(code).toBe(0);
  expect(r.upload.mock.calls[0]![0].binaries).toEqual([
    { path: f.app, required: false },
    { path: f.hermes, required: false },
  ]);
  expect(r.warnings).toEqual([`warning: no symbols for ${f.hermes}: no unstripped library; its frames stay raw.`]);
});
it.each([
  [["--strict"], {}],
  [[], { EVERFRAME_SYMBOLS_STRICT: "1" }],
])("makes discovered libraries required in strict mode (%j %j)", async (args, extra) => {
  const f = await agp();
  const r = recorder();
  await elfUploadBuildCommand(
    ["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, ...args],
    { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID, ...extra },
    r.deps
  );
  expect(r.upload.mock.calls[0]![0].binaries.every((b) => b.required)).toBe(true);
});
it("warns and keeps the build going without a token when discovering, and fails in strict mode", async () => {
  const f = await agp();
  const r = recorder();
  const args = ["--binaries-dir", f.shipped, "--symbols-dir", f.symbols];
  expect(await elfUploadBuildCommand(args, { CI: "true", EVERFRAME_APP_ID: APP_ID }, r.deps)).toBe(0);
  expect(r.warnings).toEqual([NO_TOKEN]);
  expect(r.upload).not.toHaveBeenCalled();
  await expect(elfUploadBuildCommand([...args, "--strict"], { EVERFRAME_APP_ID: APP_ID }, r.deps)).rejects.toThrow(/^missing_api_token: /);
});
it("warns about a failed upload when discovering, and keeps --binary strict", async () => {
  const f = await agp();
  const r = recorder(new Error("request_failed:network secret-token"));
  const env = { EVERFRAME_API_TOKEN: "secret-token", EVERFRAME_APP_ID: APP_ID };
  expect(await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols], env, r.deps)).toBe(0);
  expect(r.warnings).toEqual([
    "warning: everframe: symbol upload failed: request_failed:network [redacted]",
    "warning: everframe: crashes from this build will show raw addresses until its symbols are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.",
  ]);
  await expect(elfUploadBuildCommand(["--binary", f.app, "--symbols-dir", f.symbols], env, r.deps)).rejects.toThrow("request_failed:network");
});
it("rejects mixed modes and does nothing for a variant without libraries", async () => {
  const f = await agp();
  const env = { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID };
  await expect(
    elfUploadBuildCommand(["--binaries-dir", f.shipped, "--binary", f.app, "--symbols-dir", f.symbols], env)
  ).rejects.toThrow(/^elf_input_mode: /);
  const empty = join(f.root, "empty");
  await mkdir(empty);
  const r = recorder();
  expect(await elfUploadBuildCommand(["--binaries-dir", empty, "--symbols-dir", f.symbols], env, r.deps)).toBe(0);
  expect(r.upload).not.toHaveBeenCalled();
  expect(r.lines).toEqual([`No native libraries under ${empty}; nothing to upload.`]);
});
it("skips oversized and unreadable libraries in the symbols directory and names them", async () => {
  const f = await agp();
  const huge = join(f.symbols, "arm64-v8a", "libhuge.so"),
    junk = join(f.symbols, "arm64-v8a", "libjunk.so");
  await writeFile(huge, elfFixture({ id: "cc".repeat(20) }));
  await truncate(huge, 64 * 1024 * 1024 + 1);
  await writeFile(junk, "not an elf");
  const build = await collectAndroidElfBuild({
    binaries: [
      { path: f.app, required: true },
      { path: f.hermes, required: false },
    ],
    symbolsDir: f.symbols,
  });
  expect(build.artifacts).toHaveLength(1);
  const error = await collectAndroidElfBuild({ binaries: [{ path: f.hermes, required: true }], symbolsDir: f.symbols }).catch((e: Error) => e);
  expect((error as Error).message).toMatch(/^missing_matching_elf: /);
  expect((error as Error).message).toContain(`${huge} (elf_too_large)`);
  expect((error as Error).message).toContain(`${junk} (invalid_elf_binary)`);
});
it("reports an oversized optional shipped library instead of failing", async () => {
  const f = await agp();
  const big = join(f.shipped, "arm64-v8a", "libbig.so");
  await writeFile(big, elfFixture({ id: "dd".repeat(20), sections: false }));
  await truncate(big, 64 * 1024 * 1024 + 1);
  const build = await collectAndroidElfBuild({
    binaries: [
      { path: f.app, required: true },
      { path: big, required: false },
    ],
    symbolsDir: f.symbols,
  });
  expect(build.uncovered).toEqual([{ path: big, kind: "not_an_image", reason: "larger than 64 MiB" }]);
  await expect(collectAndroidElfBuild({ binaries: [{ path: big, required: true }], symbolsDir: f.symbols })).rejects.toThrow(
    `elf_too_large: ${big}`
  );
});
it("gives discovery mode the build-integration upload budget, and the explicit list none", async () => {
  const f = await agp();
  const r = recorder();
  const env = { EVERFRAME_API_TOKEN: "t", EVERFRAME_APP_ID: APP_ID };
  await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols], env, r.deps);
  expect(r.upload.mock.calls[0]![1]!.deadline! - Date.now()).toBeGreaterThan(590_000);
  await elfUploadBuildCommand(["--binary", f.app, "--symbols-dir", f.symbols], env, r.deps);
  expect(r.upload.mock.calls[1]![1]?.deadline).toBeUndefined();
});
it.each([[[]], [["--summary"]]])(
  "uploads every library in lenient mode and warns about each rejected one afterwards (%j)",
  async (extra) => {
    const f = await agp();
    const r = recorder();
    r.upload.mockResolvedValue({
      artifacts: [],
      images: [],
      uncovered: [],
      failed: [{ path: f.app, message: "request_failed:invalid_elf_binary secret-token" }],
    });
    const env = { EVERFRAME_API_TOKEN: "secret-token", EVERFRAME_APP_ID: APP_ID };
    expect(await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, ...extra], env, r.deps)).toBe(0);
    expect(r.upload.mock.calls[0]![0]).toMatchObject({ lenient: true });
    expect(r.warnings).toEqual([
      `warning: everframe: upload failed for ${f.app}: request_failed:invalid_elf_binary [redacted]`,
      "warning: everframe: crashes from this build will show raw addresses until its symbols are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.",
    ]);
    const strict = recorder();
    await elfUploadBuildCommand(["--binaries-dir", f.shipped, "--symbols-dir", f.symbols, "--strict"], env, strict.deps);
    expect(strict.upload.mock.calls[0]![0]).toMatchObject({ lenient: false });
    const manual = recorder();
    await elfUploadBuildCommand(["--binary", f.app, "--symbols-dir", f.symbols], env, manual.deps);
    expect(manual.upload.mock.calls[0]![0]).toMatchObject({ lenient: false });
  }
);
