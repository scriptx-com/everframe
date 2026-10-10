// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { open, readdir, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { AppleBinaryInput } from "./apple-build.js";

export interface AppleSymbolSource {
  binaries: AppleBinaryInput[];
  dsymDirs: string[];
}
export type AppleSourceResolution =
  | { kind: "source"; source: AppleSymbolSource }
  | { kind: "skip"; reason: string };

/** 64-bit Mach-O in either byte order and universal headers. 32-bit images are never supported. */
const MACHO_MAGICS = new Set([0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);
const SANDBOX_ADVICE =
  "Set ENABLE_USER_SCRIPT_SANDBOXING = NO for this target (everframe setup xcode does this).";

const absent = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};
async function entries(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
}
async function isMachO(path: string): Promise<boolean> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
  if (!info.isFile() || info.size < 4) return false;
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    return MACHO_MAGICS.has(head.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}
/** The Mach-O named after the bundle, else every Mach-O at the bundle root. */
async function bundleExecutables(bundle: string): Promise<string[]> {
  const named = join(bundle, basename(bundle, extname(bundle)));
  if (await isMachO(named)) return [named];
  const found: string[] = [];
  for (const name of await entries(bundle)) {
    const path = join(bundle, name);
    if (await isMachO(path)) found.push(path);
  }
  return found;
}
/** Embedded frameworks and dylibs are optional: prebuilt vendors rarely ship dSYMs. */
async function embedded(directory: string): Promise<AppleBinaryInput[]> {
  const found: AppleBinaryInput[] = [];
  for (const name of await entries(directory)) {
    const path = join(directory, name);
    if (name.endsWith(".framework"))
      for (const executable of await bundleExecutables(path)) found.push({ path: executable, required: false });
    else if (name.endsWith(".dylib") && !name.startsWith("libswift") && (await isMachO(path)))
      found.push({ path, required: false });
  }
  return found;
}

/** App and extension executables are required; Watch/ (arm64_32) and App Clips are not inspected. */
export async function discoverAppBundle(
  app: string,
  options: { executable?: string } = {}
): Promise<AppleBinaryInput[]> {
  const root = resolve(app);
  let info;
  try {
    info = await stat(root);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  if (!info?.isDirectory()) throw new Error(`invalid_app_bundle: ${root} is not an .app directory`);
  const main = options.executable ? [resolve(options.executable)] : await bundleExecutables(root);
  if (!main.length || !(await isMachO(main[0]!)))
    throw new Error(`app_executable_not_found: no 64-bit Mach-O executable in ${root}`);
  const binaries: AppleBinaryInput[] = main.map((path) => ({ path, required: true }));
  binaries.push(...(await embedded(join(root, "Frameworks"))));
  for (const folder of ["PlugIns", "Extensions"])
    for (const name of await entries(join(root, folder))) {
      if (!name.endsWith(".appex")) continue;
      const extension = join(root, folder, name);
      for (const path of await bundleExecutables(extension)) binaries.push({ path, required: true });
      binaries.push(...(await embedded(join(extension, "Frameworks"))));
    }
  return binaries;
}

export function sandboxed(error: unknown): unknown {
  const failure = error as NodeJS.ErrnoException | undefined;
  return failure?.code === "EPERM" || failure?.code === "EACCES"
    ? new Error(`xcode_script_sandboxed: Xcode denied access to ${failure.path ?? "a build product"}. ${SANDBOX_ADVICE}`)
    : error;
}

export async function resolveXcodeSource(env: NodeJS.ProcessEnv): Promise<AppleSourceResolution> {
  const { TARGET_BUILD_DIR, WRAPPER_NAME, DWARF_DSYM_FOLDER_PATH, CONFIGURATION } = env;
  if (!TARGET_BUILD_DIR || !WRAPPER_NAME || !DWARF_DSYM_FOLDER_PATH || !CONFIGURATION)
    throw new Error(
      "xcode_environment_missing: run --xcode from an Xcode Run Script phase, or pass --archive or --app"
    );
  if (env.WRAPPER_EXTENSION && env.WRAPPER_EXTENSION !== "app")
    throw new Error(
      `xcode_target_not_app: this phase runs in a .${env.WRAPPER_EXTENSION} target; add it to the application target`
    );
  if (CONFIGURATION === "Debug" && env.EVERFRAME_UPLOAD_DEBUG !== "1")
    return { kind: "skip", reason: "Debug configuration (set EVERFRAME_UPLOAD_DEBUG=1 to upload Debug symbols)" };
  if (env.DEBUG_INFORMATION_FORMAT && env.DEBUG_INFORMATION_FORMAT !== "dwarf-with-dsym")
    return {
      kind: "skip",
      reason: `DEBUG_INFORMATION_FORMAT is ${env.DEBUG_INFORMATION_FORMAT}; set it to dwarf-with-dsym for ${CONFIGURATION} to upload symbols`,
    };
  try {
    const binaries = await discoverAppBundle(
      join(TARGET_BUILD_DIR, WRAPPER_NAME),
      env.EXECUTABLE_PATH ? { executable: join(TARGET_BUILD_DIR, env.EXECUTABLE_PATH) } : {}
    );
    const dsymDirs = [
      DWARF_DSYM_FOLDER_PATH,
      ...(env.BUILT_PRODUCTS_DIR && env.BUILT_PRODUCTS_DIR !== DWARF_DSYM_FOLDER_PATH ? [env.BUILT_PRODUCTS_DIR] : []),
    ];
    return { kind: "source", source: { binaries, dsymDirs } };
  } catch (error) {
    throw sandboxed(error);
  }
}

export async function resolveArchiveSource(archive: string): Promise<AppleSymbolSource> {
  const root = resolve(archive);
  const applications = join(root, "Products", "Applications");
  const apps = (await entries(applications)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1)
    throw new Error(`archive_app_not_found: expected one .app in ${applications} (found ${apps.length})`);
  const dsyms = join(root, "dSYMs");
  const info = await stat(dsyms).catch(() => undefined);
  if (!info?.isDirectory())
    throw new Error(`archive_dsyms_missing: ${dsyms} does not exist; archive with DEBUG_INFORMATION_FORMAT = dwarf-with-dsym`);
  return { binaries: await discoverAppBundle(join(applications, apps[0]!)), dsymDirs: [dsyms] };
}
