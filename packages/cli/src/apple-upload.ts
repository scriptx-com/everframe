// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname } from "node:path";
import {
  collectAppleBuild,
  readAppleBinaryImages,
  withPath,
  type AppleBinaryInput,
  type CollectedAppleBuild,
} from "./apple-build.js";
import { collectDsymBuild } from "./dsym.js";
import { checkedRealPath } from "./manifest.js";
import { BUDGET_EXHAUSTED, uploadCollectedBuild, type UploadDependencies } from "./upload.js";
import type { BuildUploadStatus } from "@everframe/protocol";

async function verify(build: CollectedAppleBuild) {
  for (const binary of build.binaries)
    await withPath(binary.path, async () => {
      if (
        JSON.stringify(await readAppleBinaryImages(binary.path)) !==
        JSON.stringify(binary.images)
      )
        throw new Error("source_map_changed");
    });
  for (const artifact of build.artifacts) {
    const entry = artifact.manifest.artifacts[0]!;
    const path = artifact.mapPaths.get(entry.url)!,
      root = artifact.fileRoots!.get(entry.url)!.mapRoot;
    await withPath(path, async () => {
      await checkedRealPath(root, path);
      const current = await collectDsymBuild({ dwarfPath: path });
      await checkedRealPath(root, path);
      if (current.manifest.artifacts[0]!.mapSha256 !== entry.mapSha256)
        throw new Error("source_map_changed");
    });
  }
}
/** A CI gate over independent immutable artifacts, not a multi-file transaction. */
export async function uploadAppleBuild(
  options: {
    binaries: AppleBinaryInput[];
    dsymDirs: string[];
    appId: string;
    apiUrl: string;
    token: string;
    /** Build integrations: upload every matched file, then report misses and failures. */
    lenient?: boolean;
  },
  dependencies: UploadDependencies = {}
): Promise<{
  artifacts: BuildUploadStatus[];
  images: CollectedAppleBuild["images"];
  uncovered: CollectedAppleBuild["uncovered"];
  missingRequired: CollectedAppleBuild["missingRequired"];
  warnings: string[];
  /** Lenient mode: files the service did not accept, with the reason. */
  failed: Array<{ path: string; message: string }>;
}> {
  const build = await collectAppleBuild({
    binaries: options.binaries,
    dsymDirs: options.dsymDirs,
    lenient: options.lenient ?? false,
  });
  await verify(build);
  const artifacts: BuildUploadStatus[] = [],
    failed: Array<{ path: string; message: string }> = [];
  for (const local of build.artifacts) {
    const path = local.mapPaths.values().next().value!;
    try {
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
    } catch (error) {
      // One rejected file must not cost the others; the time budget stops all.
      const message = error instanceof Error ? error.message : "upload_failed";
      if (!options.lenient || message === BUDGET_EXHAUSTED) throw error;
      failed.push({ path, message });
    }
  }
  await verify(build);
  return {
    artifacts,
    images: build.images,
    uncovered: build.uncovered,
    missingRequired: build.missingRequired,
    warnings: build.warnings,
    failed,
  };
}
