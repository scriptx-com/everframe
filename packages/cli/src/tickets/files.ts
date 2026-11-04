// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES = 10;

export type ValidatedFiles =
  | { ok: true; files: { path: string; name: string; bytes: Buffer }[] }
  | { ok: false; message: string };

/**
 * Checks existence, kind and size only. The content type is the server's call:
 * its sniffer is the single copy of the upload rules.
 */
export async function validateFiles(paths: string[], max: number): Promise<ValidatedFiles> {
  if (paths.length > max)
    return { ok: false, message: `too many files: ${paths.length} given, at most ${max} allowed` };
  const files: { path: string; name: string; bytes: Buffer }[] = [];
  for (const path of paths) {
    const name = basename(path);
    let info;
    try {
      info = await stat(path);
    } catch {
      return { ok: false, message: `${path}: file not found` };
    }
    if (!info.isFile()) return { ok: false, message: `${path}: not a regular file` };
    if (info.size > MAX_FILE_BYTES) return { ok: false, message: `${path}: larger than 25 MiB` };
    try {
      files.push({ path, name, bytes: await readFile(path) });
    } catch {
      return { ok: false, message: `${path}: cannot be read` };
    }
  }
  return { ok: true, files };
}
