// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname } from "node:path";
import {
  collectAppleBuild,
  readAppleBinaryImages,
  type CollectedAppleBuild,
} from "./apple-build.js";
import { collectDsymBuild } from "./dsym.js";
import { checkedRealPath } from "./manifest.js";
import { uploadCollectedBuild, type UploadDependencies } from "./upload.js";
import type { BuildUploadStatus } from "@everframe/protocol";

async function verify(build: CollectedAppleBuild) {
  for (const binary of build.binaries) {
    if (
      JSON.stringify(await readAppleBinaryImages(binary.path)) !==
      JSON.stringify(binary.images)
    )
      throw new Error("source_map_changed");
  }
  for (const artifact of build.artifacts) {
    const entry = artifact.manifest.artifacts[0]!;
    const path = artifact.mapPaths.get(entry.url)!,
      root = artifact.fileRoots!.get(entry.url)!.mapRoot;
    await checkedRealPath(root, path);
    const current = await collectDsymBuild({ dwarfPath: path });
    await checkedRealPath(root, path);
    if (current.manifest.artifacts[0]!.mapSha256 !== entry.mapSha256)
      throw new Error("source_map_changed");
  }
}
/** A CI gate over independent immutable artifacts, not a multi-file transaction. */
export async function uploadAppleBuild(
  options: {
    binaries: string[];
    dsymDir: string;
    appId: string;
    apiUrl: string;
    token: string;
  },
  dependencies: UploadDependencies = {}
) {
  const build = await collectAppleBuild(options);
  await verify(build);
  const artifacts: BuildUploadStatus[] = [];
  for (const local of build.artifacts) {
    const path = local.mapPaths.values().next().value!;
    artifacts.push(
      await uploadCollectedBuild(
        local,
        {
          appId: options.appId,
          apiUrl: options.apiUrl,
          token: options.token,
          root: dirname(path),
          deleteAfterUpload: false,
        },
        dependencies
      )
    );
  }
  await verify(build);
  return { artifacts, images: build.images };
}
