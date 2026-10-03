// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectNativeIdentity,
  parseDwarfdumpUuids,
  parseReadelfBuildId,
  type RunCommand,
} from '../src/native-identity.js';

const DWARFDUMP = [
  'UUID: 8D6D4A1C-0F2B-3C4D-9E5F-6A7B8C9D0E1F (arm64) /tmp/App.app.dSYM/Contents/Resources/DWARF/App',
  'UUID: 1A2B3C4D-5E6F-7081-92A3-B4C5D6E7F809 (x86_64) /tmp/App.app.dSYM/Contents/Resources/DWARF/App',
].join('\n');

const READELF = [
  'Displaying notes found in: .note.gnu.build-id',
  '  Owner                Data size        Description',
  '  GNU                  0x00000014       NT_GNU_BUILD_ID (unique build ID bitstring)',
  '    Build ID: 4f2a8c1de90b3a77c2d1e0f5a6b7c8d9e0f1a2b3',
].join('\n');

describe('native identity parsing', () => {
  it('parses every dwarfdump uuid and architecture', () => {
    const parsed = parseDwarfdumpUuids(DWARFDUMP);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      uuid: '8D6D4A1C-0F2B-3C4D-9E5F-6A7B8C9D0E1F',
      arch: 'arm64',
      path: '/tmp/App.app.dSYM/Contents/Resources/DWARF/App',
    });
  });

  it('returns nothing for dwarfdump output with no uuid line', () => {
    expect(parseDwarfdumpUuids('error: unable to open')).toEqual([]);
  });

  it('parses a readelf build id', () => {
    expect(parseReadelfBuildId(READELF)).toBe('4f2a8c1de90b3a77c2d1e0f5a6b7c8d9e0f1a2b3');
  });

  it('returns undefined when the binary is stripped of its build id', () => {
    expect(parseReadelfBuildId('Displaying notes found in: .note.ABI-tag')).toBeUndefined();
  });

  it('returns empty identity when no directories are given', async () => {
    expect(await collectNativeIdentity({})).toEqual({ dsym: [], elf: [] });
  });

  it('degrades to empty identity when the tool is missing', async () => {
    const run = async () => {
      throw new Error('ENOENT');
    };
    expect(await collectNativeIdentity({ dsymDir: '/tmp/none', run })).toEqual({
      dsym: [],
      elf: [],
    });
  });
});

describe('collectNativeIdentity elf scanning', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'native-identity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('scans every ABI directory and tags entries with the directory name', async () => {
    const armDir = join(dir, 'arm64-v8a');
    const x86Dir = join(dir, 'x86_64');
    await mkdir(armDir);
    await mkdir(x86Dir);
    await writeFile(join(armDir, 'libfoo.so'), '');
    await writeFile(join(x86Dir, 'libfoo.so'), '');

    const run: RunCommand = async (file) => {
      expect(file).toBe('llvm-readelf');
      return 'Build ID: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    };

    const identity = await collectNativeIdentity({ elfDir: dir, run });

    expect(identity.elf).toHaveLength(2);
    expect(identity.elf).toEqual(
      expect.arrayContaining([
        {
          buildId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          abi: 'arm64-v8a',
          path: join(armDir, 'libfoo.so'),
        },
        {
          buildId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          abi: 'x86_64',
          path: join(x86Dir, 'libfoo.so'),
        },
      ]),
    );
  });

  it("a run failure for one .so file still yields the sibling file's entry", async () => {
    const armDir = join(dir, 'arm64-v8a');
    await mkdir(armDir);
    const goodPath = join(armDir, 'libgood.so');
    const badPath = join(armDir, 'libbad.so');
    await writeFile(goodPath, '');
    await writeFile(badPath, '');

    const run: RunCommand = async (_file, args) => {
      const path = args[1];
      if (path === badPath) throw new Error('llvm-readelf: error reading file');
      return 'Build ID: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    };

    const identity = await collectNativeIdentity({ elfDir: dir, run });

    expect(identity.elf).toEqual([
      {
        buildId: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        abi: 'arm64-v8a',
        path: goodPath,
      },
    ]);
  });

  it('skips a .so with no build-id line without error', async () => {
    const armDir = join(dir, 'arm64-v8a');
    await mkdir(armDir);
    await writeFile(join(armDir, 'libstripped.so'), '');

    const run: RunCommand = async () => 'Displaying notes found in: .note.ABI-tag';

    const identity = await collectNativeIdentity({ elfDir: dir, run });

    expect(identity.elf).toEqual([]);
  });

  it('ignores non-.so files in an ABI directory', async () => {
    const armDir = join(dir, 'arm64-v8a');
    await mkdir(armDir);
    await writeFile(join(armDir, 'README.txt'), '');
    await writeFile(join(armDir, 'libfoo.so'), '');

    const seen: string[] = [];
    const run: RunCommand = async (_file, args) => {
      const path = args[1];
      if (path) seen.push(path);
      return 'Build ID: cccccccccccccccccccccccccccccccccccccccc';
    };

    const identity = await collectNativeIdentity({ elfDir: dir, run });

    expect(seen).toEqual([join(armDir, 'libfoo.so')]);
    expect(identity.elf).toEqual([
      {
        buildId: 'cccccccccccccccccccccccccccccccccccccccc',
        abi: 'arm64-v8a',
        path: join(armDir, 'libfoo.so'),
      },
    ]);
  });

  it('returns empty identity when elfDir does not exist', async () => {
    const missing = join(dir, 'does-not-exist');
    await expect(collectNativeIdentity({ elfDir: missing })).resolves.toEqual({
      dsym: [],
      elf: [],
    });
  });

  it('scans remaining ABI directories when one is unreadable (regression)', async () => {
    const goodDir = join(dir, 'arm64-v8a');
    const badDir = join(dir, 'x86_64');
    await mkdir(goodDir);
    await mkdir(badDir);
    await writeFile(join(goodDir, 'libgood.so'), '');
    await writeFile(join(badDir, 'libbad.so'), '');
    await chmod(badDir, 0o000);

    try {
      const run: RunCommand = async () => 'Build ID: dddddddddddddddddddddddddddddddddddddddd';
      const identity = await collectNativeIdentity({ elfDir: dir, run });

      expect(identity.elf).toEqual([
        {
          buildId: 'dddddddddddddddddddddddddddddddddddddddd',
          abi: 'arm64-v8a',
          path: join(goodDir, 'libgood.so'),
        },
      ]);
    } finally {
      await chmod(badDir, 0o755);
    }
  });
});
