// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname, resolve } from 'node:path';
import type { BuildUploadStatus } from '@everframe/protocol';
import { adviceFor } from './build-verify.js';
import { collectHermesBuild } from './hermes.js';
import { readComplete, readPointer } from './staging-io.js';
import { uploadCollectedBuild, type UploadDependencies } from './upload.js';

export interface StagedHermesUploadOptions {
  stagingDir: string;
  platform: 'android' | 'ios';
  appId: string;
  apiUrl: string;
  token: string;
}

/** Uploads the platform's collected build, refusing if bundle or map changed since collect. */
export async function uploadStagedHermes(
  options: StagedHermesUploadOptions,
  dependencies: UploadDependencies = {},
): Promise<BuildUploadStatus> {
  const staged = await readComplete(options.stagingDir, await readPointer(options.stagingDir, options.platform));
  const local = await collectHermesBuild({
    buildId: staged.buildId,
    platform: options.platform,
    bundleName: staged.bundleName,
    bundlePath: staged.bundlePath,
    sourceMapPath: staged.mapPath,
  });
  const artifact = local.manifest.artifacts[0];
  if (!artifact) throw new Error('invalid_local_build');
  if (artifact.generatedSha256 !== staged.generatedSha256) throw new Error(adviceFor('staged_bundle_changed'));
  if (artifact.mapSha256 !== staged.mapSha256 || artifact.mapBytes !== staged.mapBytes)
    throw new Error(adviceFor('staged_source_map_changed'));
  return uploadCollectedBuild(
    local,
    { appId: options.appId, root: dirname(resolve(staged.mapPath)), apiUrl: options.apiUrl, token: options.token, deleteAfterUpload: false },
    dependencies,
  );
}
