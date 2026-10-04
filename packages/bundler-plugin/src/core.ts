// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { randomUUID } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { uploadBuild } from '@everframe/cli/upload';

export interface EverframeBundlerOptions {
  /** Everframe application UUID; when unset outside CI the plugin warns and does nothing. */
  appId?: string | undefined;
  /** Defaults to EVERFRAME_BUILD_ID, else a fresh UUID per build. */
  buildId?: string;
  /** Remove maps after upload so they are never deployed (default true). */
  deleteAfterUpload?: boolean;
  apiUrl?: string;
}

export interface Settings {
  appId: string;
  buildId: string;
  deleteAfterUpload: boolean;
  apiUrl: string;
  token: string | undefined;
  ci: boolean;
}

const APP_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isCi(env: NodeJS.ProcessEnv): boolean {
  return env.CI === 'true' || env.CI === '1';
}

function appIdError(appId: string | undefined): string {
  return `everframe: appId must be an Everframe application UUID, received ${JSON.stringify(appId)}.`;
}

export function resolveSettings(options: EverframeBundlerOptions, env: NodeJS.ProcessEnv): Settings {
  const appId = options.appId;
  if (appId === undefined || !APP_ID.test(appId)) throw new Error(appIdError(appId));
  return {
    appId,
    buildId: options.buildId ?? env.EVERFRAME_BUILD_ID ?? randomUUID(),
    deleteAfterUpload: options.deleteAfterUpload ?? true,
    apiUrl: options.apiUrl ?? env.EVERFRAME_API_URL ?? 'https://api.everframe.dev/api/v1',
    token: env.EVERFRAME_API_TOKEN || undefined,
    ci: isCi(env),
  };
}

/** Undefined means the plugin is disabled: a missing or invalid appId is only fatal in CI. */
export function resolvePluginSettings(
  options: EverframeBundlerOptions,
  env: NodeJS.ProcessEnv,
  log: (message: string) => void = (message) => console.warn(message),
): Settings | undefined {
  if (options.appId === undefined || !APP_ID.test(options.appId)) {
    if (isCi(env)) throw new Error(appIdError(options.appId));
    log(`${appIdError(options.appId)} Skipping build stamping and source-map upload.`);
    return undefined;
  }
  return resolveSettings(options, env);
}

export function identityBanner(buildId: string): string {
  return `globalThis.__EVERFRAME_BUILD__=${JSON.stringify({ buildId })};`;
}

async function deleteMaps(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await deleteMaps(path);
    else if (entry.name.endsWith('.js.map')) await unlink(path);
  }
}

/** Uploads the written output's maps, or enforces the missing-token policy. */
export async function finishBuild(
  outputDir: string,
  settings: Settings,
  deps: { upload?: typeof uploadBuild; log?: (message: string) => void } = {},
): Promise<void> {
  const log = deps.log ?? ((message: string) => console.warn(message));
  if (!settings.token) {
    if (settings.ci) throw new Error('missing_api_token: set EVERFRAME_API_TOKEN to a token with the artifacts:write scope.');
    log('everframe: no EVERFRAME_API_TOKEN, skipping source-map upload and removing local maps');
    if (settings.deleteAfterUpload) await deleteMaps(outputDir);
    return;
  }
  await (deps.upload ?? uploadBuild)({
    appId: settings.appId,
    buildId: settings.buildId,
    root: outputDir,
    apiUrl: settings.apiUrl,
    token: settings.token,
    deleteAfterUpload: settings.deleteAfterUpload,
  });
}
