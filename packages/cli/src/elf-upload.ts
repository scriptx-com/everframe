// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname } from 'node:path';
import type { BuildUploadStatus } from '@everframe/protocol';
import { collectAndroidElfBuild, verifyAndroidElfBuild } from './elf-build.js';
import { uploadCollectedBuild, type UploadDependencies } from './upload.js';
/** Independent immutable uploads: a later failure leaves earlier ready artifacts reusable. */
export async function uploadAndroidElfBuild(options: {
    binaries: string[];
    symbolsDir: string;
    appId: string;
    apiUrl: string;
    token: string;
}, dependencies: UploadDependencies = {}) {
    const build = await collectAndroidElfBuild(options);
    await verifyAndroidElfBuild(build);
    const artifacts: BuildUploadStatus[] = [];
    for (const local of build.artifacts) {
        artifacts.push(await uploadCollectedBuild(local, {
            appId: options.appId, apiUrl: options.apiUrl, token: options.token,
            root: dirname(local.mapPaths.values().next().value!), deleteAfterUpload: false,
        }, dependencies));
    }
    await verifyAndroidElfBuild(build);
    return { artifacts, images: build.images };
}
