// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, opendir, realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { ELF_ASSET_URL, ELF_MAX_BYTES, parseManifest } from '@everframe/protocol';
import { checkedRealPath, type LocalBuild } from './manifest.js';
import { parseElfBuildImage } from './elf-identity.js';
export interface ElfBuildImage { buildId: string; abi: 'armeabi-v7a' | 'arm64-v8a' | 'x86' | 'x86_64' | 'riscv64' }
export interface InspectedElf { image: ElfBuildImage; sha256: string; bytes: number; hasDebugInfo: boolean }
export interface CollectedAndroidElfBuild {
  images: ElfBuildImage[];
  binaries: Array<InspectedElf & { path: string; root: string }>;
  artifacts: LocalBuild[];
}
const key = (image: ElfBuildImage) => `${image.abi}/${image.buildId}`;
const unchanged = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
interface Budget { bytes: number; seen: Set<string> }
async function inspect(path: string, options: { root?: string }, budget?: Budget): Promise<InspectedElf> {
  const input = resolve(path), root = options.root ?? await realpath(dirname(input)), canonical = await checkedRealPath(root, input);
  const file = await open(input, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error('invalid_input_file');
    if (before.size < 1n || before.size > BigInt(ELF_MAX_BYTES)) throw new Error('elf_too_large');
    if (!unchanged(before, await stat(input, { bigint: true })) || canonical !== await checkedRealPath(root, input)) throw new Error('source_map_changed');
    const size = Number(before.size);
    if (budget && !budget.seen.has(canonical)) {
      budget.bytes += size; budget.seen.add(canonical);
      if (budget.bytes > 512 * 1024 * 1024) throw new Error('elf_build_limit');
    }
    const data = Buffer.allocUnsafe(size);
    let done = 0;
    while (done < size) {
      const { bytesRead } = await file.read(data, done, Math.min(64 * 1024, size - done), done);
      if (!bytesRead) throw new Error('source_map_changed'); done += bytesRead;
    }
    if (!unchanged(before, await file.stat({ bigint: true })) || !unchanged(before, await stat(input, { bigint: true })) || canonical !== await checkedRealPath(root, input)) throw new Error('source_map_changed');
    return { ...parseElfBuildImage(data), sha256: createHash('sha256').update(data).digest('hex'), bytes: size };
  } finally { await file.close(); }
}
export function inspectElfFile(path: string, options: { root?: string } = {}): Promise<InspectedElf> { return inspect(path, options); }
export async function collectAndroidElfBuild(options: { binaries: string[]; symbolsDir: string }): Promise<CollectedAndroidElfBuild> {
  if (!options.binaries.length || options.binaries.length > 16) throw new Error('elf_build_limit');
  const root = await realpath(resolve(options.symbolsDir)), budget: Budget = { bytes: 0, seen: new Set() };
  const binaries: CollectedAndroidElfBuild['binaries'] = [], paths = new Set<string>();
  for (const input of options.binaries) {
    const path = resolve(input); if (paths.has(path)) continue; paths.add(path);
    const anchor = await realpath(dirname(path));
    binaries.push({ path, root: anchor, ...await inspect(path, { root: anchor }, budget) });
  }
  const expected = new Map(binaries.map(b => [key(b.image), b.image])), selected = new Map<string, LocalBuild>(), published = new Map<string, string>();
  let entries = 0;
  const visited = new Set<string>();
  async function walk(path: string, depth: number) {
    if (depth > 8) throw new Error('elf_build_limit');
    const canonical = await checkedRealPath(root, path);
    if (visited.has(canonical)) throw new Error('elf_directory_cycle'); visited.add(canonical);
    const before = await stat(path, { bigint: true });
    if (!before.isDirectory()) throw new Error('invalid_input_file');
    const names: string[] = [], directory = await opendir(canonical);
    for await (const entry of directory) { if (++entries > 1024) throw new Error('elf_build_limit'); names.push(entry.name); }
    for (const name of names.sort()) {
      const child = join(path, name); await checkedRealPath(root, child);
      const metadata = await stat(child);
      if (metadata.isDirectory()) await walk(child, depth + 1);
      else if (name.endsWith('.so')) {
        const item = await inspect(child, { root }, budget), identity = key(item.image);
        if (!expected.has(identity) || !item.hasDebugInfo) continue;
        const previous = published.get(identity);
        if (previous && previous !== item.sha256) throw new Error('ambiguous_elf_identity');
        published.set(identity, item.sha256);
        if (!selected.has(item.sha256)) {
          if (selected.size >= 16) throw new Error('elf_build_limit');
          selected.set(item.sha256, {
            manifest: parseManifest({ version: 5, runtime: 'android-native', platform: 'android', buildId: `elf:${item.sha256}`, artifacts: [{ url: ELF_ASSET_URL, mapSha256: item.sha256, mapBytes: item.bytes }] }),
            mapPaths: new Map([[ELF_ASSET_URL, child]]), fileRoots: new Map([[ELF_ASSET_URL, { mapRoot: root }]]), uncovered: [],
          });
        }
      }
    }
    if (!unchanged(before, await stat(path, { bigint: true })) || canonical !== await checkedRealPath(root, path)) throw new Error('source_map_changed');
  }
  await walk(root, 0);
  for (const identity of expected.keys()) if (!published.has(identity)) throw new Error('missing_matching_elf');
  return { images: [...expected.values()], binaries, artifacts: [...selected.values()] };
}
