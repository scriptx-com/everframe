// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import xcode from "xcode";
import { SYMBOLS_BUILD_SETTINGS, SYMBOLS_PHASE_INPUTS, SYMBOLS_PHASE_NAME, symbolsPhaseScript } from "../src/native-setup/index.js";
import { CLI_VERSION } from "../src/version.js";
import { setupXcode } from "../src/setup-xcode.js";
import { main } from "../src/index.js";

const APP = "00000000-0000-4000-8000-000000000000";
const NO_TOKEN =
  "warning: everframe: no EVERFRAME_API_TOKEN, skipping symbol upload. Crashes from this build will show raw addresses. Set EVERFRAME_API_TOKEN to a token with the artifacts:write scope, or set EVERFRAME_SYMBOLS_STRICT=1 to fail the build instead.";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function temp(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
async function projectCopy() {
  const root = await temp("everframe-setup-xcode-");
  const dir = join(root, "App.xcodeproj");
  await mkdir(dir);
  await copyFile(join(__dirname, "fixtures/ios/project.pbxproj"), join(dir, "project.pbxproj"));
  return { root, dir, pbx: join(dir, "project.pbxproj") };
}
function load(pbx: string) {
  const project = xcode.project(pbx);
  project.parseSync();
  return project;
}
type Target = { name: string; buildPhases: Array<{ value: string; comment: string }>; buildConfigurationList: string };
function target(project: ReturnType<typeof load>, name: string): Target {
  const section = project.pbxNativeTargetSection() as Record<string, Target | string>;
  return Object.values(section).find((t): t is Target => typeof t === "object" && t.name.replace(/"/g, "") === name)!;
}
function phase(project: ReturnType<typeof load>, name: string) {
  const ref = target(project, name).buildPhases.find((p) => p.comment === SYMBOLS_PHASE_NAME)!;
  return project.hash.project.objects.PBXShellScriptBuildPhase[ref.value] as {
    shellScript: string;
    inputPaths: string[];
    alwaysOutOfDate: number | string;
  };
}
function settings(project: ReturnType<typeof load>, name: string): Array<Record<string, string>> {
  const lists = project.pbxXCConfigurationList() as Record<string, { buildConfigurations?: Array<{ value: string }> }>;
  const configs = project.pbxXCBuildConfigurationSection() as Record<string, { buildSettings: Record<string, string> }>;
  return (lists[target(project, name).buildConfigurationList]?.buildConfigurations ?? []).map(
    (r) => configs[r.value]!.buildSettings
  );
}

it("adds one last, always-run symbols phase with ordering inputs to every application target", async () => {
  const { dir, pbx } = await projectCopy();
  const result = await setupXcode({ project: dir, appId: APP, cliVersion: "1.2.3" });
  expect(result).toEqual({ changed: true, targets: expect.arrayContaining(["SampleApp", "SampleAppTV"]), xcodegen: false });
  const project = load(pbx);
  for (const name of ["SampleApp", "SampleAppTV"]) {
    const comments = target(project, name).buildPhases.map((p) => p.comment);
    expect(comments.at(-1)).toBe(SYMBOLS_PHASE_NAME);
    expect(comments.filter((c) => c === SYMBOLS_PHASE_NAME)).toHaveLength(1);
    expect(phase(project, name).inputPaths).toEqual(SYMBOLS_PHASE_INPUTS);
    expect(String(phase(project, name).alwaysOutOfDate)).toBe("1");
    // Assert on fragments only: the pbxproj parser keeps the written escaping of quotes.
    expect(phase(project, name).shellScript).toContain("dsym upload-build --xcode --app-id");
    expect(phase(project, name).shellScript).toContain(APP);
    expect(phase(project, name).shellScript).toContain("@everframe/cli@1.2.3");
    for (const s of settings(project, name)) {
      expect(s.ENABLE_USER_SCRIPT_SANDBOXING).toBe("NO");
      for (const [key, value] of Object.entries(SYMBOLS_BUILD_SETTINGS)) expect(s[key]).toBe(value);
    }
  }
});

/** Enough of Xcode's macro expansion for the input settings: $(NAME) and $(NAME:c99extidentifier). */
function expand(value: string, settings: Record<string, string>): string {
  let out = value.replace(/^"(.*)"$/, "$1");
  for (let i = 0; i < 10 && out.includes("$("); i++)
    out = out.replace(/\$\(([A-Za-z0-9_]+)(:c99extidentifier)?\)/g, (_m, name: string, op?: string) => {
      const raw = (settings[name] ?? "").replace(/^"(.*)"$/, "$1");
      return op ? raw.replace(/[^A-Za-z0-9_]/g, "_") : raw;
    });
  return out;
}
it.each([
  ["dwarf", "/build/Debug-iphonesimulator/App.app/Info.plist"],
  ["dwarf-with-dsym", "/build/Release-iphoneos/App.app.dSYM/Contents/Resources/DWARF/App"],
])("declares an input that exists for DEBUG_INFORMATION_FORMAT=%s", (format, expected) => {
  const xcode = format === "dwarf"
    ? { TARGET_BUILD_DIR: "/build/Debug-iphonesimulator", INFOPLIST_PATH: "App.app/Info.plist" }
    : { DWARF_DSYM_FOLDER_PATH: "/build/Release-iphoneos", DWARF_DSYM_FILE_NAME: "App.app.dSYM", EXECUTABLE_NAME: "App" };
  const environment = { ...SYMBOLS_BUILD_SETTINGS, ...xcode, DEBUG_INFORMATION_FORMAT: format };
  expect(expand(SYMBOLS_PHASE_INPUTS[0]!, environment)).toBe(expected);
});
it("is idempotent", async () => {
  const { dir, pbx } = await projectCopy();
  await setupXcode({ project: dir, appId: APP, cliVersion: "1.2.3" });
  const once = await readFile(pbx, "utf8");
  expect((await setupXcode({ project: dir, appId: APP, cliVersion: "1.2.3" })).changed).toBe(false);
  expect(await readFile(pbx, "utf8")).toBe(once);
});
it("narrows to --target and rejects unknown targets with the valid names", async () => {
  const { dir, pbx } = await projectCopy();
  expect((await setupXcode({ project: dir, appId: APP, cliVersion: "1.2.3", targets: ["SampleAppTV"] })).targets).toEqual([
    "SampleAppTV",
  ]);
  const project = load(pbx);
  expect(target(project, "SampleApp").buildPhases.some((p) => p.comment === SYMBOLS_PHASE_NAME)).toBe(false);
  await expect(setupXcode({ project: dir, cliVersion: "1.2.3", targets: ["Nope"] })).rejects.toThrow(
    /^xcode_target_not_found: Nope is not an application target \(found: .*SampleApp/
  );
});
it("reports an XcodeGen spec beside the project", async () => {
  const { root, dir } = await projectCopy();
  await writeFile(join(root, "project.yml"), "name: App\n");
  expect((await setupXcode({ project: dir, cliVersion: "1.2.3" })).xcodegen).toBe(true);
});
it("prints the phase script for XcodeGen with the installed CLI version", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    expect(await main(["setup", "xcode", "--print-script"], {})).toBe(0);
    const printed = String(log.mock.calls[0]![0]);
    expect(printed.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(printed).toContain("dsym upload-build --xcode");
    expect(printed).toMatch(/@everframe\/cli@\d+\.\d+\.\d+/);
  } finally {
    log.mockRestore();
  }
});

describe("the phase script", () => {
  async function harness(exitCode = 0) {
    const root = await temp("everframe-symbols-script-");
    const stub = join(root, "cli.mjs"),
      record = join(root, "args.json");
    await writeFile(
      stub,
      `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2))); process.exit(${exitCode});`
    );
    const script = symbolsPhaseScript({ appId: APP, cliVersion: "1.2.3" });
    const run = (env: Record<string, string>) =>
      spawnSync("bash", ["-c", script], {
        env: { PATH: process.env.PATH!, SRCROOT: root, NODE_BINARY: process.execPath, CONFIGURATION: "Release", EVERFRAME_CLI_JS: stub, ...env },
        encoding: "utf8",
      });
    const ran = async () => access(record).then(() => true, () => false);
    const args = async () => JSON.parse(await readFile(record, "utf8")) as string[];
    return { root, run, ran, args };
  }
  it.each([{}, { CI: "true" }, { CI: "1" }])("warns and skips without a token, locally and in CI, without starting Node (%o)", async (env) => {
    const h = await harness();
    const result = h.run(env);
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([NO_TOKEN]);
    expect(await h.ran()).toBe(false);
  });
  it("skips Debug builds before looking for a token", async () => {
    const h = await harness();
    const result = h.run({ CONFIGURATION: "Debug" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("everframe: skipping symbol upload: Debug configuration");
    expect(result.stdout).not.toContain("warning:");
    expect(await h.ran()).toBe(false);
  });
  it("runs the CLI with the app id when a token is set", async () => {
    const h = await harness();
    expect(h.run({ EVERFRAME_API_TOKEN: "t" }).status).toBe(0);
    expect(await h.args()).toEqual(["dsym", "upload-build", "--xcode", "--app-id", APP]);
  });
  it("runs the CLI without a token in strict mode so it can fail the build", async () => {
    const h = await harness();
    h.run({ EVERFRAME_SYMBOLS_STRICT: "1" });
    expect(await h.args()).toEqual(["dsym", "upload-build", "--xcode", "--app-id", APP]);
  });
  it("turns a failed CLI run into a warning, and into a failure in strict mode", async () => {
    const h = await harness(3);
    const lenient = h.run({ EVERFRAME_API_TOKEN: "t" });
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("warning: everframe: the symbol upload stopped with exit status 3");
    expect(h.run({ EVERFRAME_API_TOKEN: "t", EVERFRAME_SYMBOLS_STRICT: "1" }).status).toBe(3);
  });
  it("warns about a sandboxed Run Script before starting Node, and fails when strict", async () => {
    const h = await harness();
    const lenient = h.run({ EVERFRAME_API_TOKEN: "t", ENABLE_USER_SCRIPT_SANDBOXING: "YES" });
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain("warning: everframe: xcode_script_sandboxed: ");
    expect(lenient.stdout).toContain("Set ENABLE_USER_SCRIPT_SANDBOXING = NO");
    expect(await h.ran()).toBe(false);
    const strict = h.run({ EVERFRAME_API_TOKEN: "t", ENABLE_USER_SCRIPT_SANDBOXING: "YES", EVERFRAME_SYMBOLS_STRICT: "1" });
    expect(strict.status).toBe(1);
    expect(strict.stdout).toContain("error: everframe: xcode_script_sandboxed: ");
  });
  it("tolerates unset variables in the project's .xcode.env", async () => {
    const h = await harness();
    await writeFile(join(h.root, ".xcode.env"), 'export EVERFRAME_TEST_FROM_ENV="$EVERFRAME_TEST_NEVER_SET"\n');
    const result = h.run({ EVERFRAME_API_TOKEN: "t" });
    expect(result.stderr).not.toContain("unbound variable");
    expect(result.status).toBe(0);
    expect(await h.ran()).toBe(true);
  });
  it("keeps the build going when Node is missing", async () => {
    const h = await harness();
    const result = h.run({ EVERFRAME_API_TOKEN: "t", NODE_BINARY: "/nonexistent/node" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("warning: everframe: the symbol upload stopped with exit status 127");
  });
});
it("bounds the npx fallback so a stalled registry cannot stall the build", () => {
  const script = symbolsPhaseScript({ cliVersion: "1.2.3" });
  expect(script).toMatch(/npm_config_fetch_timeout=\d+ npm_config_fetch_retries=1 npm_config_fetch_retry_maxtimeout=\d+ npx --yes --prefer-offline "@everframe\/cli@1\.2\.3"/);
});
it("keeps the native example's phase script in sync with --print-script", async () => {
  const committed = await readFile(join(__dirname, "../../../examples/ios-native/scripts/upload-everframe-symbols.sh"), "utf8");
  const body = committed.split("\n").filter((line) => !line.startsWith("#")).join("\n").trim();
  // The pinned version follows package.json; a release bump must not fail this check.
  const unpinned = (text: string) => text.replace(/@everframe\/cli@[0-9A-Za-z.-]+/g, "@everframe/cli@<version>");
  expect(unpinned(body)).toBe(unpinned(symbolsPhaseScript({ cliVersion: CLI_VERSION })));
});
it("omits --app-id so EVERFRAME_APP_ID applies when no app id is given", () => {
  const script = symbolsPhaseScript({ cliVersion: "1.2.3" });
  expect(script).toContain("dsym upload-build --xcode");
  expect(script).not.toContain("--app-id");
});
