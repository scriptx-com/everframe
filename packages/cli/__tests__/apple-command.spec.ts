// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { dsymUploadBuildCommand } from "../src/apple-command.js";
import type { uploadAppleBuild } from "../src/apple-upload.js";
import { adviceFor } from "../src/build-verify.js";
import { main } from "../src/index.js";
import { appBundle, UUID_B } from "./apple-build-fixture.js";

const APP_ID = "00000000-0000-4000-8000-000000000001";
const NO_TOKEN =
  "warning: everframe: no EVERFRAME_API_TOKEN, skipping symbol upload. Crashes from this build will show raw addresses. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function xcode(overrides: Record<string, string | undefined> = {}) {
  const root = await mkdtemp(join(tmpdir(), "everframe-apple-command-"));
  roots.push(root);
  const bundle = await appBundle(root);
  await mkdir(join(root, "dsyms"));
  const env: NodeJS.ProcessEnv = {
    TARGET_BUILD_DIR: root,
    WRAPPER_NAME: "App.app",
    WRAPPER_EXTENSION: "app",
    EXECUTABLE_PATH: "App.app/App",
    DWARF_DSYM_FOLDER_PATH: join(root, "dsyms"),
    BUILT_PRODUCTS_DIR: root,
    CONFIGURATION: "Release",
    DEBUG_INFORMATION_FORMAT: "dwarf-with-dsym",
    EVERFRAME_APP_ID: APP_ID,
    EVERFRAME_API_TOKEN: "secret",
    ...overrides,
  };
  return { root, bundle, env };
}
function recorder(
  uncovered: Awaited<ReturnType<typeof uploadAppleBuild>>["uncovered"] = [],
  failure?: Error
) {
  const upload = vi.fn<typeof uploadAppleBuild>(async () => {
    if (failure) throw failure;
    return { artifacts: [], images: [], uncovered };
  });
  const lines: string[] = [],
    warnings: string[] = [];
  return {
    upload,
    lines,
    warnings,
    deps: { upload, log: (l: string) => lines.push(l), warn: (l: string) => warnings.push(l) },
  };
}

it.each([undefined, "true", "1"])(
  "warns and keeps the build going without a token (CI=%s)",
  async (ci) => {
    const f = await xcode({ EVERFRAME_API_TOKEN: undefined, CI: ci });
    const r = recorder();
    expect(await dsymUploadBuildCommand(["--xcode"], f.env, r.deps)).toBe(0);
    expect(r.warnings).toEqual([NO_TOKEN]);
    expect(r.lines).toEqual([]);
    expect(r.upload).not.toHaveBeenCalled();
  }
);
it.each([
  [["--xcode", "--strict"], {}],
  [["--xcode"], { EVERFRAME_SYMBOLS_STRICT: "1" }],
])("fails without a token in strict mode (%j %j)", async (args, extra) => {
  const f = await xcode({ EVERFRAME_API_TOKEN: undefined, ...extra });
  await expect(dsymUploadBuildCommand(args, f.env, recorder().deps)).rejects.toThrow(/^missing_api_token: /);
});
it("skips Debug builds before looking for a token and prints why", async () => {
  const f = await xcode({ CONFIGURATION: "Debug", EVERFRAME_API_TOKEN: undefined });
  const r = recorder();
  expect(await dsymUploadBuildCommand(["--xcode"], f.env, r.deps)).toBe(0);
  expect(r.lines).toEqual([
    "everframe: skipping symbol upload: Debug configuration (set EVERFRAME_UPLOAD_DEBUG=1 to upload Debug symbols)",
  ]);
  expect(r.warnings).toEqual([]);
  expect(r.upload).not.toHaveBeenCalled();
});
it("uploads the discovered app, framework and extension from an Xcode build", async () => {
  const f = await xcode();
  const r = recorder();
  expect(await dsymUploadBuildCommand(["--xcode"], f.env, r.deps)).toBe(0);
  expect(r.upload).toHaveBeenCalledWith({
    appId: APP_ID,
    token: "secret",
    apiUrl: "https://api.everframe.dev/api/v1",
    binaries: [
      { path: f.bundle.executable, required: true },
      { path: f.bundle.framework, required: false },
      { path: f.bundle.extension, required: true },
    ],
    dsymDirs: [join(f.root, "dsyms"), f.root],
  });
});
it.each([
  [["--xcode", "--strict"], {}],
  [["--xcode"], { EVERFRAME_SYMBOLS_STRICT: "1" }],
])("makes every binary required in strict mode (%j %j)", async (args, extra) => {
  const f = await xcode(extra);
  const r = recorder();
  await dsymUploadBuildCommand(args, f.env, r.deps);
  expect(r.upload.mock.calls[0]![0].binaries.every((b) => b.required)).toBe(true);
});
it("uses an archive's dSYMs folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "everframe-apple-command-"));
  roots.push(root);
  const archive = join(root, "App.xcarchive");
  await appBundle(join(archive, "Products", "Applications"));
  await mkdir(join(archive, "dSYMs"));
  const r = recorder();
  await dsymUploadBuildCommand(["--archive", archive, "--app-id", APP_ID], { EVERFRAME_API_TOKEN: "secret" }, r.deps);
  expect(r.upload.mock.calls[0]![0].dsymDirs).toEqual([join(archive, "dSYMs")]);
});
it("prints one Xcode warning per uncovered optional binary", async () => {
  const f = await xcode();
  const r = recorder([
    { path: "/b/Feature", images: [{ uuid: UUID_B, cpuType: 0x100000c, cpuSubtype: 0, architecture: "arm64" }] },
  ]);
  await dsymUploadBuildCommand(["--xcode"], f.env, r.deps);
  expect(r.warnings).toEqual([
    `warning: no dSYM for /b/Feature (arm64 ${UUID_B}); its frames stay raw. Prebuilt frameworks need their vendor's dSYMs; pass --strict to fail instead.`,
  ]);
});
it("explains an optional binary it could not read", async () => {
  const f = await xcode();
  const r = recorder([{ path: "/b/Vendor", images: [], reason: "unsupported_apple_architecture" }]);
  await dsymUploadBuildCommand(["--xcode"], f.env, r.deps);
  expect(r.warnings).toEqual([
    "warning: no dSYM for /b/Vendor: not a supported 64-bit Mach-O (unsupported_apple_architecture); its frames stay raw. Pass --strict to fail instead.",
  ]);
});
it("caps uncovered-binary warnings at sixteen lines plus a count", async () => {
  const f = await xcode();
  const image = { uuid: UUID_B, cpuType: 0x100000c, cpuSubtype: 0, architecture: "arm64" as const };
  const r = recorder(Array.from({ length: 20 }, (_, i) => ({ path: `/b/Vendor${i}`, images: [image] })));
  await dsymUploadBuildCommand(["--xcode"], f.env, r.deps);
  expect(r.warnings).toHaveLength(17);
  expect(r.warnings[16]).toBe("warning: and 4 more binaries without dSYMs");
});
it("warns and keeps the build going when the upload fails, with the token redacted", async () => {
  const f = await xcode();
  const r = recorder([], new Error("request_failed:network secret"));
  expect(await dsymUploadBuildCommand(["--xcode"], f.env, r.deps)).toBe(0);
  expect(r.warnings).toEqual([
    "warning: everframe: symbol upload failed: request_failed:network [redacted]",
    "warning: everframe: crashes from this build will show raw addresses until its symbols are uploaded. Set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.",
  ]);
});
it("explains a full artifact quota in the failure warning", async () => {
  const f = await xcode();
  const r = recorder([], new Error("request_failed:project_quota_exceeded"));
  await dsymUploadBuildCommand(["--xcode"], f.env, r.deps);
  expect(r.warnings[0]).toMatch(/^warning: everframe: symbol upload failed: request_failed:project_quota_exceeded: .*storage quota/);
});
it("warns about a required binary without a dSYM instead of failing the build", async () => {
  const f = await xcode();
  const r = recorder([], new Error("missing_matching_dsym: no DWARF file under /d matches these required images"));
  expect(await dsymUploadBuildCommand(["--xcode"], f.env, r.deps)).toBe(0);
  expect(r.warnings[0]).toBe(
    "warning: everframe: symbol upload failed: missing_matching_dsym: no DWARF file under /d matches these required images"
  );
});
it("warns about a missing app ID instead of failing the build", async () => {
  const f = await xcode({ EVERFRAME_APP_ID: undefined });
  const r = recorder();
  expect(await dsymUploadBuildCommand(["--xcode"], f.env, r.deps)).toBe(0);
  expect(r.warnings[0]).toMatch(/^warning: everframe: symbol upload failed: missing_app_id: /);
  expect(r.upload).not.toHaveBeenCalled();
});
it.each([
  [["--xcode", "--strict"], {}],
  [["--xcode"], { EVERFRAME_SYMBOLS_STRICT: "1" }],
  [["--xcode"], { EVERFRAME_SYMBOLS_STRICT: "true" }],
])("fails the build on an upload failure in strict mode (%j %j)", async (args, extra) => {
  const f = await xcode(extra);
  const r = recorder([], new Error("request_failed:network"));
  await expect(dsymUploadBuildCommand(args, f.env, r.deps)).rejects.toThrow("request_failed:network");
  expect(r.warnings).toEqual([]);
});
it("keeps the explicit --binary list strict: failures fail the command", async () => {
  const f = await xcode();
  const r = recorder([], new Error("request_failed:network"));
  await expect(
    dsymUploadBuildCommand(["--binary", f.bundle.executable, "--dsym-dir", f.root], f.env, r.deps)
  ).rejects.toThrow("request_failed:network");
  await expect(
    dsymUploadBuildCommand(["--binary", f.bundle.executable, "--dsym-dir", f.root], { ...f.env, EVERFRAME_API_TOKEN: undefined }, r.deps)
  ).rejects.toThrow(/^missing_api_token: /);
});
it("explains a sandboxed Run Script phase in the warning", async () => {
  const f = await xcode();
  const denied = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES", path: "/x/App.app/Frameworks" });
  const r = recorder([], denied);
  await dsymUploadBuildCommand(["--xcode"], f.env, r.deps);
  expect(r.warnings[0]).toMatch(
    /^warning: everframe: symbol upload failed: xcode_script_sandboxed: Xcode denied access to \/x\/App\.app\/Frameworks\. Set ENABLE_USER_SCRIPT_SANDBOXING = NO/
  );
});
it("rejects mixed or missing input modes", async () => {
  const env = { EVERFRAME_API_TOKEN: "secret", EVERFRAME_APP_ID: APP_ID };
  await expect(dsymUploadBuildCommand(["--xcode", "--archive", "x"], env, recorder().deps)).rejects.toThrow(/^apple_input_mode: /);
  await expect(dsymUploadBuildCommand([], env, recorder().deps)).rejects.toThrow(/^apple_input_mode: /);
  await expect(dsymUploadBuildCommand(["--app", "x"], env, recorder().deps)).rejects.toThrow(/^missing_required_option: --dsym-dir/);
  await expect(dsymUploadBuildCommand(["--xcode", "--dsym-dir", "x"], env, recorder().deps)).rejects.toThrow(/^apple_input_mode: /);
});
it("routes main() to the command", async () => {
  const f = await xcode({ EVERFRAME_API_TOKEN: undefined });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(await main(["dsym", "upload-build", "--xcode"], f.env)).toBe(0);
    expect(warn).toHaveBeenCalledWith(NO_TOKEN);
  } finally {
    warn.mockRestore();
  }
});
it("explains a full project artifact quota", () => {
  expect(adviceFor("request_failed:project_quota_exceeded")).toMatch(/^request_failed:project_quota_exceeded: .*storage quota/);
});
it("the archive shell example runs the CLI without demanding a token", async () => {
  const root = await mkdtemp(join(tmpdir(), "everframe-apple-command-"));
  roots.push(root);
  const capture = join(root, "args.json"),
    script = join(root, "local entry.mjs");
  await writeFile(
    script,
    '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs"; writeFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\n'
  );
  const env = { ...process.env, EVERFRAME_APP_ID: APP_ID, EVERFRAME_API_TOKEN: "", EVERFRAME_CLI_JS: script, CAPTURE: capture };
  const result = spawnSync("bash", [resolve("examples/upload-apple-symbols.sh"), "App with spaces.xcarchive"], { env, encoding: "utf8" });
  expect(result.status).toBe(0);
  expect(JSON.parse(await readFile(capture, "utf8"))).toEqual(["dsym", "upload-build", "--archive", "App with spaces.xcarchive"]);
});
