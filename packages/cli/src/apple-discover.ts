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

/** LC_LOAD_DYLIB, LC_LOAD_WEAK_DYLIB, LC_REEXPORT_DYLIB, LC_LAZY_LOAD_DYLIB and LC_LOAD_UPWARD_DYLIB. */
const LOAD_DYLIB = new Set([0xc, 0x80000018, 0x8000001f, 0x20, 0x80000023]);
const RPATH_FRAMEWORK = /^@(?:rpath|executable_path\/Frameworks|loader_path\/Frameworks)\/([^/]+\.framework)\/[^/]+$/;
/**
 * Framework bundles a Mach-O loads by run path, read from the load commands of
 * every 64-bit slice. Unreadable or unexpected files link nothing.
 */
export async function linkedFrameworks(path: string): Promise<string[]> {
  const found = new Set<string>();
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (absent(error)) return [];
    throw error;
  }
  try {
    const read = async (offset: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    };
    const head = await read(0, 8);
    if (head.length < 8) return [];
    const magic = head.readUInt32BE(0);
    const slices: number[] = [];
    if (magic === 0xcafebabe || magic === 0xcafebabf) {
      const wide = magic === 0xcafebabf, count = Math.min(head.readUInt32BE(4), 16), size = wide ? 32 : 20;
      const table = await read(8, count * size);
      for (let i = 0; i + size <= table.length; i += size)
        slices.push(wide ? Number(table.readBigUInt64BE(i + 8)) : table.readUInt32BE(i + 8));
    } else slices.push(0);
    for (const offset of slices) {
      const header = await read(offset, 32);
      if (header.length < 32 || header.readUInt32LE(0) !== 0xfeedfacf) continue;
      const commands = header.readUInt32LE(16), size = header.readUInt32LE(20);
      if (size > 4 * 1024 * 1024) continue;
      const body = await read(offset + 32, size);
      for (let at = 0, n = 0; n < commands && at + 8 <= body.length; n++) {
        const cmd = body.readUInt32LE(at), cmdsize = body.readUInt32LE(at + 4);
        if (cmdsize < 8 || at + cmdsize > body.length) break;
        if (LOAD_DYLIB.has(cmd) && cmdsize >= 24) {
          const nameOffset = body.readUInt32LE(at + 8);
          if (nameOffset < cmdsize) {
            const raw = body.subarray(at + nameOffset, at + cmdsize);
            const end = raw.indexOf(0);
            const name = raw.subarray(0, end < 0 ? raw.length : end).toString("utf8");
            const match = RPATH_FRAMEWORK.exec(name);
            if (match) found.add(match[1]!);
          }
        }
        at += cmdsize;
      }
    }
  } finally {
    await handle.close();
  }
  return [...found].sort();
}
/** Bundles that never contain separately built frameworks. */
const NOT_A_PRODUCTS_FOLDER = /\.(app|appex|framework|xcframework|dSYM|bundle|swiftmodule|xctest|docc|xcarchive|lproj|build)$/i;
/**
 * Framework bundles under BUILT_PRODUCTS_DIR, including one-folder-per-target
 * layouts (CocoaPods' per-pod configuration build dirs, XCFrameworkIntermediates).
 */
async function productFrameworks(directory: string, limits = { depth: 3, entries: 16384 }): Promise<Map<string, string[]>> {
  const index = new Map<string, string[]>();
  let seen = 0;
  async function walk(path: string, depth: number): Promise<void> {
    for (const name of await entries(path)) {
      if (++seen > limits.entries) return;
      const child = join(path, name);
      if (name.endsWith(".framework")) {
        index.set(name, [...(index.get(name) ?? []), child]);
        continue;
      }
      if (depth >= limits.depth || NOT_A_PRODUCTS_FOLDER.test(name)) continue;
      let info;
      try {
        info = await stat(child);
      } catch (error) {
        if (absent(error)) continue;
        throw error;
      }
      if (info.isDirectory()) await walk(child, depth + 1);
    }
  }
  await walk(directory, 0);
  return index;
}
/**
 * In React Native and Expo apps, CocoaPods' "[CP] Embed Pods Frameworks" runs
 * after the upload phase, so dynamic pod frameworks are not in the bundle yet.
 * Their binaries and dSYMs are already in the build products: follow the run
 * path links of the app, its extensions and their frameworks to the
 * frameworks the embed phase will copy. Only linked frameworks are listed, and
 * a dSYM uploads only when its UUID matches, so unrelated build products are
 * never sent. All of them are optional.
 */
export async function linkedProductFrameworks(
  roots: AppleBinaryInput[],
  productsDir: string,
  limit = 256
): Promise<AppleBinaryInput[]> {
  const embeddedNames = new Set(
    roots.map((binary) => /\/([^/]+\.framework)\/[^/]+$/.exec(binary.path)?.[1]).filter((name): name is string => !!name)
  );
  let index: Map<string, string[]> | undefined;
  const queue = roots.map((binary) => binary.path), visited = new Set(queue), found: AppleBinaryInput[] = [];
  while (queue.length && found.length < limit) {
    for (const name of await linkedFrameworks(queue.shift()!)) {
      if (embeddedNames.has(name)) continue;
      index ??= await productFrameworks(productsDir);
      for (const bundle of index.get(name) ?? [])
        for (const executable of await bundleExecutables(bundle)) {
          if (visited.has(executable) || found.length >= limit) continue;
          visited.add(executable);
          found.push({ path: executable, required: false });
          queue.push(executable);
        }
    }
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
  if (env.ENABLE_USER_SCRIPT_SANDBOXING === "YES")
    throw new Error(`xcode_script_sandboxed: Xcode sandboxes this Run Script phase. ${SANDBOX_ADVICE}`);
  try {
    const binaries = await discoverAppBundle(
      join(TARGET_BUILD_DIR, WRAPPER_NAME),
      env.EXECUTABLE_PATH ? { executable: join(TARGET_BUILD_DIR, env.EXECUTABLE_PATH) } : {}
    );
    if (env.BUILT_PRODUCTS_DIR) binaries.push(...(await linkedProductFrameworks(binaries, env.BUILT_PRODUCTS_DIR)));
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
