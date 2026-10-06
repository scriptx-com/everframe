// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import type { Stats } from 'node:fs';
import { open, readFile, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseStagedBuild, type StagedBuild } from '@everframe/protocol';
import { hashFile } from './manifest.js';
import { collectNativeIdentity, type RunCommand } from './native-identity.js';
import { readPartial, writeComplete, writePointer } from './staging-io.js';

import { readBundleIdentity, assertCompiledBuildIdentity } from './bundle-identity.js';

const HERMES_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const MAP_MAX_BYTES = 32 * 1024 * 1024;

export interface CollectOptions {
  stagingDir: string;
  platform: 'android' | 'ios';
  bundlePath: string;
  mapPath: string;
  dsymDir?: string;
  elfDir?: string;
  run?: RunCommand;
}

/**
 * Filesystem failures here are the single most likely way this command
 * fails in a real build (a wrong `--bundle`/`--source-map` path, or an iOS
 * build that never exported `SOURCEMAP_FILE`), and Node's own errno message
 * — `ENOENT: no such file or directory, stat '…'` — names neither the
 * artifact nor the fix. Translate them into the same coded vocabulary the
 * rest of the staging pipeline uses, keeping the missing-bundle and
 * missing-map cases distinguishable, so `build-verify`'s advice table can
 * turn them into an actionable sentence.
 */
async function assertHermesBytecode(path: string): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch {
    throw new Error('bundle_not_found');
  }
  try {
    const magic = Buffer.alloc(HERMES_MAGIC.length);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== magic.length || !magic.equals(HERMES_MAGIC))
      throw new Error('invalid_hermes_bytecode');
  } finally {
    await handle.close();
  }
}

async function statSourceMap(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch {
    throw new Error('source_map_not_found');
  }
}

export async function collectStagedBuild(options: CollectOptions): Promise<StagedBuild> {
  const bundlePath = resolve(options.bundlePath);
  const mapPath = resolve(options.mapPath);
  await assertHermesBytecode(bundlePath);

  const mapStat = await statSourceMap(mapPath);
  if (mapStat.size <= 0) throw new Error('source_map_empty');
  if (mapStat.size > MAP_MAX_BYTES) throw new Error('source_map_too_large');

  let sourceMap: unknown;
  try { sourceMap = JSON.parse(await readFile(mapPath, 'utf8')); } catch { throw new Error('invalid_bundle_identity'); }
  const identity = readBundleIdentity(sourceMap, options.platform);
  const partial = await readPartial(options.stagingDir, identity.buildId);
  if (partial.buildId !== identity.buildId || partial.platform !== identity.platform || partial.bundleName !== identity.bundleName)
    throw new Error('staged_identity_mismatch');
  await assertCompiledBuildIdentity(bundlePath, identity.buildId);

  const [generatedSha256, mapSha256] = await Promise.all([
    hashFile(bundlePath),
    hashFile(mapPath),
  ]);

  const staged = parseStagedBuild({
    ...partial,
    bundlePath,
    mapPath,
    generatedSha256,
    mapSha256,
    mapBytes: mapStat.size,
    native: await collectNativeIdentity({
      ...(options.dsymDir !== undefined && { dsymDir: options.dsymDir }),
      ...(options.elfDir !== undefined && { elfDir: options.elfDir }),
      ...(options.run !== undefined && { run: options.run }),
    }),
  });
  await writeComplete(options.stagingDir, staged);
  await writePointer(options.stagingDir, options.platform, staged.buildId);
  return staged;
}
