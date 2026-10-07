// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, truncate, realpath, rename, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseElfBuildImage } from '../src/elf-identity.js';
import { collectAndroidElfBuild, inspectElfFile } from '../src/elf-build.js';
import { elfFixture } from './elf-build-fixtures.js';
vi.mock('node:fs/promises', async (original) => { const actual = await original<typeof import('node:fs/promises')>(); return { ...actual, open: vi.fn(actual.open) }; });
const roots: string[] = [];
export async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'elf-build-'));
    roots.push(root);
    const binary = join(root, 'shipped.so'), symbolsDir = join(root, 'symbols');
    await mkdir(symbolsDir);
    const symbol = join(symbolsDir, 'anything.so');
    await writeFile(binary, elfFixture({ sections: false }));
    await writeFile(symbol, elfFixture());
    return { root, binary, symbol, symbolsDir };
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
describe('ELF build identity', () => {
    it.each([[40, false, 'armeabi-v7a'], [183, true, 'arm64-v8a'], [3, false, 'x86'], [62, true, 'x86_64'], [243, true, 'riscv64']] as const)('reads machine %i using ELF class, never filenames', (machine, wide, abi) => {
        expect(parseElfBuildImage(elfFixture({ machine, wide }))).toEqual({ image: { buildId: '1234567890abcdef', abi }, hasDebugInfo: true });
    });
    it.each([{ sections: false }, { debug: false }])('accepts stripped shipped input but never as symbol coverage %j', options => {
        expect(parseElfBuildImage(elfFixture(options)).hasDebugInfo).toBe(false);
    });
    it.each([
        ['magic', (b: Buffer) => { b[0] = 0; }], ['endian', (b: Buffer) => { b[5] = 2; }],
        ['version', (b: Buffer) => { b.writeUInt32LE(2, 20); }], ['kind', (b: Buffer) => { b.writeUInt16LE(1, 16); }],
        ['class/machine', (b: Buffer) => { b.writeUInt16LE(40, 18); }],
        ['uint64 bounds', (b: Buffer) => { b.writeBigUInt64LE(1n << 63n, 40); }],
        ['extended count', (b: Buffer) => { b.writeUInt16LE(65535, 56); }],
        ['extended section count', (b: Buffer) => { b.writeUInt16LE(0, 60); }],
        ['extended strings', (b: Buffer) => { b.writeUInt16LE(65535, 62); }],
        ['missing ID', (b: Buffer) => { b.writeUInt32LE(2, 264); }],
        ['oversized ID', (b: Buffer) => { b.writeUInt32LE(65, 260); }],
        ['no executable segment', (b: Buffer) => { b.writeUInt32LE(4, 68); }],
        ['invalid note bounds', (b: Buffer) => { b.writeBigUInt64LE(2048n, 128); }],
        ['section bounds', (b: Buffer) => { b.writeBigUInt64LE(2048n, 920); }],
        ['unterminated name', (b: Buffer) => { b.fill(65, 512, 548); }],
    ] as const)('rejects %s', (_, mutate) => { const b = elfFixture(); mutate(b); expect(() => parseElfBuildImage(b)).toThrow(); });
    it('rejects conflicting GNU notes even when one looks valid', () => {
        const b = elfFixture();
        b.copy(b, 600, 256, 280);
        b[616] = 0xff;
        b.writeUInt32LE(7, 900);
        b.writeBigUInt64LE(600n, 920);
        b.writeBigUInt64LE(24n, 928);
        expect(() => parseElfBuildImage(b)).toThrow('conflicting_elf_build_id');
    });
    it('does not accept compressed core debug sections', () => {
        const b = elfFixture();
        b.writeBigUInt64LE(0x800n, 904);
        expect(parseElfBuildImage(b).hasDebugInfo).toBe(false);
    });
});
describe('exact ELF collection', () => {
    it('pins full hashes and deduplicates repeated paths and equal symbol bytes', async () => {
        const f = await fixture();
        await writeFile(join(f.symbolsDir, 'duplicate.so'), await readFile(f.symbol));
        await writeFile(join(f.symbolsDir, 'stripped.so'), elfFixture({ debug: false }));
        const build = await collectAndroidElfBuild({ binaries: [f.binary, f.binary], symbolsDir: f.symbolsDir });
        expect(build.images).toEqual([{ buildId: '1234567890abcdef', abi: 'arm64-v8a' }]);
        expect(build.binaries).toHaveLength(1);
        expect(build.artifacts).toHaveLength(1);
        expect(build.binaries[0]?.sha256).toBe(createHash('sha256').update(await readFile(f.binary)).digest('hex'));
        expect(build.artifacts[0]?.manifest).toMatchObject({ version: 5, runtime: 'android-native', artifacts: [{ mapBytes: 1024 }] });
        expect(build.artifacts[0]?.fileRoots?.get('elf://android/library')?.mapRoot).toBe(await realpath(f.symbolsDir));
    });
    it('matches two modules across ABIs independently of paths', async () => {
        const f = await fixture(), second = join(f.root, 'other.so');
        await writeFile(second, elfFixture({ machine: 3, wide: false, sections: false }));
        await mkdir(join(f.symbolsDir, 'incorrect-abi-name'));
        await writeFile(join(f.symbolsDir, 'incorrect-abi-name', 'other.so'), elfFixture({ machine: 3, wide: false }));
        const build = await collectAndroidElfBuild({ binaries: [f.binary, second], symbolsDir: f.symbolsDir });
        expect(build.images.map(i => i.abi)).toEqual(['arm64-v8a', 'x86']);
        expect(build.artifacts).toHaveLength(2);
    });
    it.each([{ debug: false }, { id: 'ffffffff' }, { machine: 62 }])('rejects absent exact unstripped coverage %j', async (options) => {
        const f = await fixture();
        await writeFile(f.symbol, elfFixture(options));
        await expect(collectAndroidElfBuild({ binaries: [f.binary], symbolsDir: f.symbolsDir })).rejects.toThrow('missing_matching_elf');
    });
    it('rejects different unstripped bytes claiming the same identity', async () => {
        const f = await fixture(), bytes = elfFixture();
        bytes[577] = 123;
        await writeFile(join(f.symbolsDir, 'ambiguous.so'), bytes);
        await expect(collectAndroidElfBuild({ binaries: [f.binary], symbolsDir: f.symbolsDir })).rejects.toThrow('ambiguous_elf_identity');
    });
    it('rejects zero and more than sixteen requested binaries', async () => {
        const f = await fixture();
        for (const binaries of [[], Array(17).fill(f.binary)])
            await expect(collectAndroidElfBuild({ binaries, symbolsDir: f.symbolsDir })).rejects.toThrow('elf_build_limit');
    });
    it('rejects excess directory entries and nesting', async () => {
        const f = await fixture();
        await Promise.all(Array.from({ length: 1024 }, (_, n) => writeFile(join(f.symbolsDir, `${n}.txt`), '')));
        await expect(collectAndroidElfBuild({ binaries: [f.binary], symbolsDir: f.symbolsDir })).rejects.toThrow('elf_build_limit');
        const deep = await fixture();
        await mkdir(join(deep.symbolsDir, ...Array(9).fill('nested')), { recursive: true });
        await expect(collectAndroidElfBuild({ binaries: [deep.binary], symbolsDir: deep.symbolsDir })).rejects.toThrow('elf_build_limit');
    });
    it('rejects oversized files and FIFOs without blocking', async () => {
        const f = await fixture();
        await truncate(f.binary, 64 * 1024 * 1024 + 1);
        await expect(inspectElfFile(f.binary)).rejects.toThrow('elf_too_large');
        const fifo = join(f.root, 'fifo.so');
        execFileSync('mkfifo', [fifo]);
        await expect(inspectElfFile(fifo)).rejects.toThrow('invalid_input_file');
    });
    it('rejects escaping links and directory cycles', async () => {
        const f = await fixture(), outside = await fixture();
        await symlink(outside.symbol, join(f.symbolsDir, 'escape.so'));
        await expect(collectAndroidElfBuild({ binaries: [f.binary], symbolsDir: f.symbolsDir })).rejects.toThrow('symlink_escapes_root');
        await rm(join(f.symbolsDir, 'escape.so'));
        await symlink(f.symbolsDir, join(f.symbolsDir, 'cycle'));
        await expect(collectAndroidElfBuild({ binaries: [f.binary], symbolsDir: f.symbolsDir })).rejects.toThrow('elf_directory_cycle');
    });
    it.each(['replace', 'grow', 'parent-escape'])('rejects a %s during descriptor inspection', async (action) => {
        const f = await fixture(), outside = await fixture(), actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
        const spy = vi.mocked(open).mockImplementation(async (...args) => {
            const file = await actualOpen(...args), read = file.read.bind(file);
            let changed = false;
            file.read = (async (...readArgs: Parameters<typeof read>) => {
                const result = await read(...readArgs);
                if (!changed) {
                    changed = true;
                    if (action === 'replace') {
                        await rename(f.binary, f.binary + '.old');
                        await writeFile(f.binary, elfFixture({ sections: false }));
                    }
                    else if (action === 'grow')
                        await truncate(f.binary, 2048);
                    else {
                        await rename(f.root, f.root + '.old');
                        roots.push(f.root + '.old');
                        await symlink(outside.root, f.root);
                    }
                }
                return result;
            }) as typeof file.read;
            return file;
        });
        await expect(inspectElfFile(f.binary)).rejects.toThrow();
        spy.mockImplementation(actualOpen);
    });
    it('bounds total distinct scanned bytes before inspecting another large input', async () => {
        const f = await fixture();
        await rm(f.symbol);
        for (let i = 0; i < 9; i++) {
            const path = join(f.symbolsDir, `${i}.so`);
            await writeFile(path, elfFixture());
            await truncate(path, 64 * 1024 * 1024);
        }
        await expect(collectAndroidElfBuild({ binaries: [f.binary], symbolsDir: f.symbolsDir })).rejects.toThrow('elf_build_limit');
    }, 15000);
});
