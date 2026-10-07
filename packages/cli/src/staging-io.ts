// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  parseStagedBuild,
  parseStagedBuildPartial,
  type StagedBuild,
  type StagedBuildPartial,
} from '@everframe/protocol';

/** Build ids name a directory, so they may never traverse. */
function checkedBuildId(buildId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(buildId) || buildId.includes('..'))
    throw new Error('invalid_build_id');
  return buildId;
}

/** Wrap Zod parser to surface schema failures as invalid_staged_manifest. */
function parseStaged<T>(parse: (input: unknown) => T, input: unknown): T {
  try {
    return parse(input);
  } catch {
    throw new Error('invalid_staged_manifest');
  }
}

async function readJson(path: string, missing: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(missing);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid_staged_manifest');
  }
}

export async function readPointer(
  stagingDir: string,
  platform: 'android' | 'ios',
): Promise<string> {
  const pointer = await readJson(join(stagingDir, `latest-${platform}.json`), 'no_staged_build');
  const buildId = (pointer as { buildId?: unknown }).buildId;
  if (typeof buildId !== 'string') throw new Error('invalid_staged_manifest');
  return checkedBuildId(buildId);
}

export async function readPartial(
  stagingDir: string,
  buildId: string,
): Promise<StagedBuildPartial> {
  const path = join(stagingDir, checkedBuildId(buildId), 'manifest.partial.json');
  return parseStaged(parseStagedBuildPartial, await readJson(path, 'no_staged_build'));
}

export async function readComplete(stagingDir: string, buildId: string): Promise<StagedBuild> {
  const path = join(stagingDir, checkedBuildId(buildId), 'manifest.json');
  return parseStaged(parseStagedBuild, await readJson(path, 'manifest_not_collected'));
}

export async function writeComplete(stagingDir: string, staged: StagedBuild): Promise<void> {
  const path = join(stagingDir, checkedBuildId(staged.buildId), 'manifest.json');
  await writeFile(path, `${JSON.stringify(staged, null, 2)}\n`);
}

/** Promote only a successfully collected build to the existing verify/upload pointer. */
export async function writePointer(stagingDir: string, platform: 'android' | 'ios', buildId: string): Promise<void> {
  const id = checkedBuildId(buildId);
  const target = join(stagingDir, `latest-${platform}.json`);
  const temporary = join(stagingDir, `.latest-${platform}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify({ buildId: id })}\n`, { flag: 'wx' });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}
