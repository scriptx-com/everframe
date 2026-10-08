// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  DSYM_ASSET_URL,
  DSYM_MAX_BYTES,
  parseManifest,
} from "@everframe/protocol";
import { checkedRealPath, type LocalBuild } from "./manifest.js";

export interface CollectDsymBuildOptions {
  dwarfPath: string;
}

export async function collectDsymBuild(
  options: CollectDsymBuildOptions
): Promise<LocalBuild> {
  const input = resolve(options.dwarfPath),
    root = await realpath(dirname(input));
  const path = await checkedRealPath(root, input);
  // Nonblocking descriptor checks also reject a raced FIFO or symlink. Reads
  // have a hard ceiling even when a build process keeps growing the file.
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  let sha: string,
    length = 0;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("invalid_input_file");
    if (metadata.size <= 0 || metadata.size > DSYM_MAX_BYTES)
      throw new Error("dsym_too_large");
    const chunk = Buffer.allocUnsafe(64 * 1024),
      hash = createHash("sha256");
    for (;;) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, length);
      if (!bytesRead) break;
      length += bytesRead;
      if (length > metadata.size || length > DSYM_MAX_BYTES)
        throw new Error("source_map_changed");
      hash.update(chunk.subarray(0, bytesRead));
    }
    if (length !== metadata.size || (await file.stat()).size !== length)
      throw new Error("source_map_changed");
    sha = hash.digest("hex");
  } finally {
    await file.close();
  }
  const manifest = parseManifest({
    version: 4,
    runtime: "apple",
    platform: "apple",
    buildId: "dsym:" + sha,
    artifacts: [{ url: DSYM_ASSET_URL, mapSha256: sha, mapBytes: length }],
  });
  return {
    manifest,
    mapPaths: new Map([[DSYM_ASSET_URL, input]]),
    fileRoots: new Map([[DSYM_ASSET_URL, { mapRoot: root }]]),
    uncovered: [],
  };
}
