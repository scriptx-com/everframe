// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { R8_ASSET_URL, parseManifest } from "@everframe/protocol";
import { checkedRealPath, hashFile, type LocalBuild } from "./manifest.js";

export interface CollectR8BuildOptions {
  mappingId: string;
  mappingPath: string;
}

export async function collectR8Build(
  options: CollectR8BuildOptions,
): Promise<LocalBuild> {
  const mapInput = resolve(options.mappingPath);
  const mapRoot = await realpath(dirname(mapInput));
  const mappingPath = await checkedRealPath(mapRoot, mapInput);
  const metadata = await stat(mappingPath);
  if (!metadata.isFile()) throw new Error("invalid_input_file");
  if (metadata.size <= 0 || metadata.size > 32 * 1024 * 1024)
    throw new Error("source_map_too_large");

  const manifest = parseManifest({
    version: 3,
    runtime: "r8",
    platform: "android",
    buildId: options.mappingId,
    artifacts: [
      {
        url: R8_ASSET_URL,
        mapSha256: await hashFile(mappingPath),
        mapBytes: metadata.size,
      },
    ],
  });
  if (manifest.version !== 3) throw new Error("invalid_local_build");
  return {
    manifest,
    mapPaths: new Map([[R8_ASSET_URL, mapInput]]),
    fileRoots: new Map([[R8_ASSET_URL, { mapRoot }]]),
    uncovered: [],
  };
}
