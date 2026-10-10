// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ELF_ASSET_URL, ELF_MAX_BYTES, parseManifest } from '@everframe/protocol';
import { checkedRealPath, type LocalBuild } from './manifest.js';
import { parseElfBuildImage } from './elf-identity.js';
export interface ElfBuildImage {
    buildId: string;
    abi: 'armeabi-v7a' | 'arm64-v8a' | 'x86' | 'x86_64' | 'riscv64';
}
export interface InspectedElf {
    image: ElfBuildImage;
    sha256: string;
    bytes: number;
    hasDebugInfo: boolean;
}
export interface ElfBinaryInput {
    path: string;
    /** A required library without matching debug info fails; an optional one is reported in `uncovered`. */
    required: boolean;
}
export interface ElfBuildLimits {
    binaries: number;
    artifacts: number;
    inspectedBytes: number;
    directoryEntries: number;
    depth: number;
}
export const ELF_BUILD_LIMITS: ElfBuildLimits = { binaries: 256, artifacts: 128, inspectedBytes: 4 * 1024 ** 3, directoryEntries: 16384, depth: 8 };
/** Why an optional shipped file is not an uploadable image. */
const NOT_AN_IMAGE = new Map([['invalid_elf_binary', 'no GNU build ID or not a shared library'], ['unsupported_elf_architecture', 'unsupported ABI'], ['elf_too_large', 'larger than 64 MiB']]);
/** Names the file behind a bare failure code; other errors pass through. */
function named(error: unknown, path: string): unknown {
    return error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? new Error(`${error.message}: ${path}`) : error;
}
export interface CollectedAndroidElfBuild {
    /** Images covered by a selected unstripped library. */
    images: ElfBuildImage[];
    binaries: Array<InspectedElf & {
        path: string;
        root: string;
        required: boolean;
    }>;
    artifacts: LocalBuild[];
    /**
     * Optional libraries without uploaded symbols, with the reason. `prebuilt`:
     * every copy in the build lacks debug information, as for libraries that
     * AARs and SDKs ship stripped. `missing`: no unstripped copy was found.
     * `not_an_image`: not a symbolicatable shared library.
     */
    uncovered: Array<{ path: string; reason: string; kind: 'prebuilt' | 'missing' | 'not_an_image' }>;
}
const key = (image: ElfBuildImage) => `${image.abi}/${image.buildId}`;
const unchanged = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
interface Budget {
    bytes: number;
    seen: Set<string>;
    limit: number;
}
async function inspect(path: string, options: {
    root?: string;
}, budget?: Budget): Promise<InspectedElf> {
    const input = resolve(path), root = options.root ?? await realpath(dirname(input)), canonical = await checkedRealPath(root, input);
    const file = await open(input, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
        const before = await file.stat({ bigint: true });
        if (!before.isFile())
            throw new Error('invalid_input_file');
        if (before.size < 1n || before.size > BigInt(ELF_MAX_BYTES))
            throw new Error('elf_too_large');
        if (!unchanged(before, await stat(input, { bigint: true })) || canonical !== await checkedRealPath(root, input))
            throw new Error('source_map_changed');
        const size = Number(before.size);
        if (budget && !budget.seen.has(canonical)) {
            budget.bytes += size;
            budget.seen.add(canonical);
            if (budget.bytes > budget.limit)
                throw new Error(`elf_build_limit: more than ${budget.limit} bytes inspected`);
        }
        const data = Buffer.allocUnsafe(size);
        let done = 0;
        while (done < size) {
            const { bytesRead } = await file.read(data, done, Math.min(64 * 1024, size - done), done);
            if (!bytesRead)
                throw new Error('source_map_changed');
            done += bytesRead;
        }
        if (!unchanged(before, await file.stat({ bigint: true })) || !unchanged(before, await stat(input, { bigint: true })) || canonical !== await checkedRealPath(root, input))
            throw new Error('source_map_changed');
        return { ...parseElfBuildImage(data), sha256: createHash('sha256').update(data).digest('hex'), bytes: size };
    }
    finally {
        await file.close();
    }
}
export function inspectElfFile(path: string, options: {
    root?: string;
} = {}): Promise<InspectedElf> { return inspect(path, options); }
export async function collectAndroidElfBuild(
    options: { binaries: ElfBinaryInput[]; symbolsDir: string },
    limits: ElfBuildLimits = ELF_BUILD_LIMITS,
): Promise<CollectedAndroidElfBuild> {
    if (!options.binaries.length || options.binaries.length > limits.binaries)
        throw new Error(`elf_build_limit: list 1 to ${limits.binaries} binaries (got ${options.binaries.length})`);
    const root = await realpath(resolve(options.symbolsDir)), budget: Budget = { bytes: 0, seen: new Set(), limit: limits.inspectedBytes };
    const binaries: CollectedAndroidElfBuild['binaries'] = [], uncovered: CollectedAndroidElfBuild['uncovered'] = [], paths = new Set<string>();
    for (const input of options.binaries) {
        const path = resolve(input.path);
        if (paths.has(path))
            continue;
        paths.add(path);
        const anchor = await realpath(dirname(path));
        try {
            binaries.push({ path, root: anchor, required: input.required, ...await inspect(path, { root: anchor }, budget) });
        }
        catch (error) {
            const reason = error instanceof Error ? NOT_AN_IMAGE.get(error.message) : undefined;
            if (input.required || !reason)
                throw named(error, path);
            uncovered.push({ path, reason, kind: 'not_an_image' });
        }
    }
    if (!binaries.length)
        return { images: [], binaries, artifacts: [], uncovered };
    const expected = new Map(binaries.map(b => [key(b.image), b.image])), selected = new Map<string, LocalBuild>(), published = new Map<string, string>();
    const skipped: string[] = [], withoutDebugInfo = new Set<string>();
    let entries = 0;
    const visited = new Set<string>();
    async function walk(path: string, depth: number) {
        if (depth > limits.depth)
            throw new Error(`elf_build_limit: symbols directory nests more than ${limits.depth} levels`);
        const canonical = await checkedRealPath(root, path);
        if (visited.has(canonical))
            throw new Error('elf_directory_cycle');
        visited.add(canonical);
        const before = await stat(path, { bigint: true });
        if (!before.isDirectory())
            throw new Error('invalid_input_file');
        const names: string[] = [], directory = await opendir(canonical);
        for await (const entry of directory) {
            if (++entries > limits.directoryEntries)
                throw new Error(`elf_build_limit: more than ${limits.directoryEntries} directory entries under ${root}`);
            names.push(entry.name);
        }
        for (const name of names.sort()) {
            const child = join(path, name);
            await checkedRealPath(root, child);
            const metadata = await stat(child);
            if (metadata.isDirectory())
                await walk(child, depth + 1);
            else if (name.endsWith('.so')) {
                let item: InspectedElf;
                try {
                    item = await inspect(child, { root }, budget);
                }
                catch (error) {
                    // Unrelated files (a huge third-party library, a stray non-ELF .so)
                    // cannot hold a listed identity; they must not stop the others.
                    if (!(error instanceof Error) || !NOT_AN_IMAGE.has(error.message))
                        throw named(error, child);
                    skipped.push(`  ${child} (${error.message})`);
                    continue;
                }
                const identity = key(item.image);
                if (!expected.has(identity))
                    continue;
                if (!item.hasDebugInfo) {
                    withoutDebugInfo.add(identity);
                    continue;
                }
                const previous = published.get(identity);
                if (previous && previous !== item.sha256)
                    throw new Error('ambiguous_elf_identity');
                published.set(identity, item.sha256);
                if (!selected.has(item.sha256)) {
                    if (selected.size >= limits.artifacts)
                        throw new Error(`elf_build_limit: more than ${limits.artifacts} distinct unstripped libraries match`);
                    selected.set(item.sha256, {
                        manifest: parseManifest({ version: 5, runtime: 'android-native', platform: 'android', buildId: `elf:${item.sha256}`, artifacts: [{ url: ELF_ASSET_URL, mapSha256: item.sha256, mapBytes: item.bytes }] }),
                        mapPaths: new Map([[ELF_ASSET_URL, child]]), fileRoots: new Map([[ELF_ASSET_URL, { mapRoot: root }]]), uncovered: [],
                    });
                }
            }
        }
        if (!unchanged(before, await stat(path, { bigint: true })) || canonical !== await checkedRealPath(root, path))
            throw new Error('source_map_changed');
    }
    await walk(root, 0);
    const missing: string[] = [];
    for (const binary of binaries) {
        if (published.has(key(binary.image)))
            continue;
        if (binary.required)
            missing.push(`  ${binary.image.abi} ${binary.image.buildId} in ${binary.path}`);
        else if (withoutDebugInfo.has(key(binary.image)))
            uncovered.push({ path: binary.path, kind: 'prebuilt', reason: `prebuilt without debug information (build ID ${binary.image.buildId}, ${binary.image.abi})` });
        else
            uncovered.push({ path: binary.path, kind: 'missing', reason: `no unstripped library with build ID ${binary.image.buildId} (${binary.image.abi}) under ${root}` });
    }
    if (missing.length)
        throw new Error([`missing_matching_elf: no unstripped library with debug info under ${root} matches these required images:`,
            ...(missing.length > 8 ? [...missing.slice(0, 8), `  and ${missing.length - 8} more`] : missing),
            ...(skipped.length ? ['Skipped files that are not readable shared libraries:', ...(skipped.length > 8 ? [...skipped.slice(0, 8), `  and ${skipped.length - 8} more`] : skipped)] : [])].join('\n'));
    const covered = new Map(binaries.filter(b => published.has(key(b.image))).map(b => [key(b.image), b.image]));
    return { images: [...covered.values()], binaries, artifacts: [...selected.values()], uncovered };
}
/** Shipped `.so` files under a directory such as AGP's `lib/<abi>/`, in a stable order. */
export async function discoverElfBinaries(directory: string, limits: ElfBuildLimits = ELF_BUILD_LIMITS): Promise<string[]> {
    const found: string[] = [];
    let entries = 0;
    async function walk(path: string, depth: number): Promise<void> {
        if (depth > limits.depth)
            throw new Error(`elf_build_limit: ${directory} nests more than ${limits.depth} levels`);
        const children = (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of children) {
            if (++entries > limits.directoryEntries)
                throw new Error(`elf_build_limit: more than ${limits.directoryEntries} entries under ${directory}`);
            const child = join(path, entry.name);
            if (entry.isDirectory())
                await walk(child, depth + 1);
            else if (entry.isFile() && entry.name.endsWith('.so'))
                found.push(child);
        }
    }
    await walk(resolve(directory), 0);
    return found;
}
/** Recheck complete selected bytes under one bounded verification pass. */
export async function verifyAndroidElfBuild(build: CollectedAndroidElfBuild): Promise<void> {
    const budget: Budget = { bytes: 0, seen: new Set(), limit: ELF_BUILD_LIMITS.inspectedBytes };
    for (const binary of build.binaries) {
        const current = await inspect(binary.path, { root: binary.root }, budget);
        if (current.sha256 !== binary.sha256 || current.bytes !== binary.bytes)
            throw new Error('source_map_changed');
    }
    for (const artifact of build.artifacts) {
        const entry = artifact.manifest.artifacts[0]!, path = artifact.mapPaths.get(entry.url)!, root = artifact.fileRoots!.get(entry.url)!.mapRoot;
        const current = await inspect(path, { root }, budget);
        if (current.sha256 !== entry.mapSha256 || current.bytes !== entry.mapBytes || !current.hasDebugInfo)
            throw new Error('source_map_changed');
    }
}
