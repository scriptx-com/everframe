// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { R8_ASSET_URL, R8_MAX_BYTES, parseManifest } from "@everframe/protocol";
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
  if (metadata.size <= 0)
    throw new Error(`r8_mapping_empty: the R8 mapping ${basename(mapInput)} is empty; upload the mapping.txt R8 wrote for this build.`);
  if (metadata.size > R8_MAX_BYTES)
    throw new Error(
      `r8_mapping_too_large: the R8 mapping ${mapInput} is ${mebibytes(metadata.size)} MiB (${metadata.size} bytes); Everframe accepts R8 mappings up to ${R8_MAX_BYTES / 1024 / 1024} MiB.`,
    );

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

function mebibytes(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}
