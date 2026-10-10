// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { dirname } from 'node:path';
import type { BuildUploadStatus } from '@everframe/protocol';
import { collectAndroidElfBuild, verifyAndroidElfBuild, type CollectedAndroidElfBuild, type ElfBinaryInput } from './elf-build.js';
import { BUDGET_EXHAUSTED, uploadCollectedBuild, type UploadDependencies } from './upload.js';
/** Independent immutable uploads: a later failure leaves earlier ready artifacts reusable. */
export async function uploadAndroidElfBuild(options: {
    binaries: ElfBinaryInput[];
    symbolsDir: string;
    appId: string;
    apiUrl: string;
    token: string;
    /** Build integrations: upload every matched file, then report the ones the service rejected. */
    lenient?: boolean;
}, dependencies: UploadDependencies = {}): Promise<{
    artifacts: BuildUploadStatus[];
    images: CollectedAndroidElfBuild['images'];
    uncovered: CollectedAndroidElfBuild['uncovered'];
    /** Lenient mode: files the service did not accept, with the reason. */
    failed: Array<{ path: string; message: string }>;
}> {
    const build = await collectAndroidElfBuild({ binaries: options.binaries, symbolsDir: options.symbolsDir });
    await verifyAndroidElfBuild(build);
    const artifacts: BuildUploadStatus[] = [], failed: Array<{ path: string; message: string }> = [];
    for (const local of build.artifacts) {
        const path = local.mapPaths.values().next().value!;
        try {
            artifacts.push(await uploadCollectedBuild(local, {
                appId: options.appId, apiUrl: options.apiUrl, token: options.token,
                root: dirname(path), deleteAfterUpload: false,
            }, dependencies));
        }
        catch (error) {
            // One rejected file must not cost the others; the time budget stops all.
            const message = error instanceof Error ? error.message : 'upload_failed';
            if (!options.lenient || message === BUDGET_EXHAUSTED)
                throw error;
            failed.push({ path, message });
        }
    }
    await verifyAndroidElfBuild(build);
    return { artifacts, images: build.images, uncovered: build.uncovered, failed };
}
