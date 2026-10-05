// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { StagedNativeIdentity } from '@everframe/protocol';

const execFileAsync = promisify(execFile);

export type RunCommand = (file: string, args: string[]) => Promise<string>;

const defaultRun: RunCommand = async (file, args) =>
  (await execFileAsync(file, args, { maxBuffer: 8 * 1024 * 1024 })).stdout;

export function parseDwarfdumpUuids(
  output: string,
): Array<{ uuid: string; arch: string; path: string }> {
  const results: Array<{ uuid: string; arch: string; path: string }> = [];
  for (const line of output.split('\n')) {
    const match = /^UUID:\s+([0-9A-Fa-f-]{36})\s+\(([^)]+)\)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const [, uuid, arch, path] = match;
    if (!uuid || !arch || !path) continue;
    results.push({ uuid, arch, path });
  }
  return results;
}

export function parseReadelfBuildId(output: string): string | undefined {
  return /Build ID:\s*([0-9a-f]+)/.exec(output)?.[1];
}

/** Identifier collection only: epics 4 and 5 own the upload contracts. Never throws. */
export async function collectNativeIdentity(options: {
  dsymDir?: string;
  elfDir?: string;
  run?: RunCommand;
}): Promise<StagedNativeIdentity> {
  const run = options.run ?? defaultRun;
  const identity: StagedNativeIdentity = { dsym: [], elf: [] };

  if (options.dsymDir) {
    try {
      identity.dsym = parseDwarfdumpUuids(await run('dwarfdump', ['--uuid', options.dsymDir]));
    } catch {
      identity.dsym = [];
    }
  }

  if (options.elfDir) {
    try {
      const abiEntries = await readdir(options.elfDir, { withFileTypes: true });
      for (const abi of abiEntries) {
        if (!abi.isDirectory()) continue;
        const abiPath = join(options.elfDir, abi.name);
        let files: string[];
        try {
          files = await readdir(abiPath);
        } catch {
          // One unreadable ABI directory does not stop the others from being scanned.
          continue;
        }
        for (const file of files) {
          if (!file.endsWith('.so')) continue;
          const path = join(abiPath, file);
          try {
            const buildId = parseReadelfBuildId(await run('llvm-readelf', ['-n', path]));
            if (buildId) identity.elf.push({ buildId, abi: abi.name, path });
          } catch {
            // A stripped or unreadable library is reported as absent, not as a failure.
          }
        }
      }
    } catch {
      // The top-level elfDir is missing or unreadable: whatever was collected so far
      // (nothing, in this case) stands. Partial results are strictly better than none.
    }
  }

  return identity;
}
