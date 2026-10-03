// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { open, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { hermesAssetUrl, parseManifest } from "@everframe/protocol";
import { checkedRealPath, hashFile, type LocalBuild } from "./manifest.js";

export interface CollectHermesBuildOptions {
  buildId: string;
  platform: "android" | "ios";
  bundleName: string;
  bundlePath: string;
  sourceMapPath: string;
}

export async function collectHermesBuild(
  options: CollectHermesBuildOptions,
): Promise<LocalBuild> {
  const bundleInput = resolve(options.bundlePath);
  const mapInput = resolve(options.sourceMapPath);
  const generatedRoot = await realpath(dirname(bundleInput));
  const mapRoot = await realpath(dirname(mapInput));
  const bundlePath = await checkedRealPath(generatedRoot, bundleInput);
  const sourceMapPath = await checkedRealPath(mapRoot, mapInput);
  if (bundlePath === sourceMapPath) throw new Error("same_input_file");

  const [bundleMetadata, mapMetadata] = await Promise.all([
    stat(bundlePath),
    stat(sourceMapPath),
  ]);
  if (
    bundleMetadata.dev === mapMetadata.dev &&
    bundleMetadata.ino === mapMetadata.ino
  )
    throw new Error("same_input_file");
  if (!bundleMetadata.isFile() || !mapMetadata.isFile())
    throw new Error("invalid_input_file");
  if (mapMetadata.size <= 0 || mapMetadata.size > 32 * 1024 * 1024)
    throw new Error("source_map_too_large");

  const handle = await open(bundlePath, "r");
  const magic = Buffer.alloc(8);
  try {
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (
      bytesRead !== magic.length ||
      !magic.equals(
        Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]),
      )
    )
      throw new Error("invalid_hermes_bytecode");
  } finally {
    await handle.close();
  }

  const url = hermesAssetUrl(options.platform, options.bundleName);
  const [generatedSha256, mapSha256] = await Promise.all([
    hashFile(bundlePath),
    hashFile(sourceMapPath),
  ]);
  const manifest = parseManifest({
    version: 2,
    runtime: "hermes",
    platform: options.platform,
    buildId: options.buildId,
    artifacts: [
      {
        url,
        generatedSha256,
        mapSha256,
        mapBytes: mapMetadata.size,
      },
    ],
  });
  if (manifest.version !== 2) throw new Error("invalid_local_build");
  return {
    manifest,
    mapPaths: new Map([[url, mapInput]]),
    generatedPaths: new Map([[url, bundleInput]]),
    fileRoots: new Map([[url, { generatedRoot, mapRoot }]]),
    uncovered: [],
  };
}
