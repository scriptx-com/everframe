// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname } from 'node:path';
import type { BuildUploadStatus } from '@everframe/protocol';
import { collectAndroidElfBuild, verifyAndroidElfBuild, type CollectedAndroidElfBuild, type ElfBinaryInput } from './elf-build.js';
import { uploadCollectedBuild, type UploadDependencies } from './upload.js';
/** Independent immutable uploads: a later failure leaves earlier ready artifacts reusable. */
export async function uploadAndroidElfBuild(options: {
    binaries: ElfBinaryInput[];
    /** The project's own native build outputs; see collectAndroidElfBuild. */
    projectDirs?: string[] | undefined;
    symbolsDir: string;
    appId: string;
    apiUrl: string;
    token: string;
}, dependencies: UploadDependencies = {}): Promise<{
    artifacts: BuildUploadStatus[];
    images: CollectedAndroidElfBuild['images'];
    uncovered: CollectedAndroidElfBuild['uncovered'];
}> {
    const build = await collectAndroidElfBuild({ binaries: options.binaries, symbolsDir: options.symbolsDir, projectDirs: options.projectDirs });
    await verifyAndroidElfBuild(build);
    const artifacts: BuildUploadStatus[] = [];
    for (const local of build.artifacts) {
        artifacts.push(await uploadCollectedBuild(local, {
            appId: options.appId, apiUrl: options.apiUrl, token: options.token,
            root: dirname(local.mapPaths.values().next().value!), deleteAfterUpload: false,
        }, dependencies));
    }
    await verifyAndroidElfBuild(build);
    return { artifacts, images: build.images, uncovered: build.uncovered };
}
