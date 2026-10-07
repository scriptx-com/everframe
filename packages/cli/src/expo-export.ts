// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { collectStagedBuild } from './build-collect.js';
import { adviceFor, verifyStagedBuild } from './build-verify.js';
import { uploadStagedHermes } from './staged-upload.js';
import type { UploadDependencies } from './upload.js';

const PLATFORMS = ['android', 'ios'] as const;

export async function resolveExpoAppId(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  projectRoot: string,
): Promise<string> {
  if (explicit) return explicit;
  if (env.EVERFRAME_APP_ID) return env.EVERFRAME_APP_ID;
  try {
    const json = JSON.parse(await readFile(join(projectRoot, 'app.json'), 'utf8')) as {
      expo?: { plugins?: unknown[] };
    };
    for (const plugin of json.expo?.plugins ?? []) {
      if (Array.isArray(plugin) && plugin[0] === '@everframe/expo') {
        const appId = (plugin[1] as { appId?: unknown } | undefined)?.appId;
        if (typeof appId === 'string' && appId) return appId;
      }
    }
  } catch {
    // No static app.json; fall through to the error below.
  }
  throw new Error('missing_app_id');
}

export interface ExpoExportOptions {
  distDir: string;
  stagingDir: string;
  appId: string;
  apiUrl: string;
  token: string;
}

/** Collect, verify and upload each platform `expo export` produced. */
export async function uploadExpoExport(
  options: ExpoExportOptions,
  dependencies: UploadDependencies = {},
): Promise<Array<{ platform: 'android' | 'ios'; buildUuid: string }>> {
  const results: Array<{ platform: 'android' | 'ios'; buildUuid: string }> = [];
  for (const platform of PLATFORMS) {
    const dir = join(options.distDir, '_expo', 'static', 'js', platform);
    const files = await readdir(dir).catch(() => undefined);
    if (!files) continue;
    const bundles = files.filter((name) => name.endsWith('.hbc'));
    if (bundles.length !== 1 || !files.includes(`${bundles[0]}.map`))
      throw new Error(`expo_export_ambiguous:${platform}`);
    const bundlePath = join(dir, bundles[0]!);
    try {
      await collectStagedBuild({ stagingDir: options.stagingDir, platform, bundlePath, mapPath: `${bundlePath}.map` });
    } catch (error) {
      throw new Error(adviceFor(error instanceof Error ? error.message : 'collect_failed'));
    }
    const verified = await verifyStagedBuild({
      stagingDir: options.stagingDir,
      platform,
      release: true,
      allowMissing: false,
      hasToken: Boolean(options.token),
    });
    if (!verified.ok) throw new Error(verified.failures.join('\n'));
    const status = await uploadStagedHermes({ ...options, platform }, dependencies);
    results.push({ platform, buildUuid: status.buildUuid });
  }
  if (results.length === 0) throw new Error('no_expo_export');
  return results;
}
