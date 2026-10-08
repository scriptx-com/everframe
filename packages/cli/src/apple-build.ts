// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DSYM_MAX_BYTES } from "@everframe/protocol";
import { checkedRealPath, type LocalBuild } from "./manifest.js";
import { collectDsymBuild } from "./dsym.js";

export interface AppleBuildImage {
  uuid: string;
  cpuType: number;
  /** Base subtype; CPU capability flags are not an alternate image identity. */
  cpuSubtype: number;
  architecture: "arm64" | "arm64e" | "x86_64" | "x86_64h";
}
export interface CollectedAppleBuild {
  artifacts: LocalBuild[];
  images: AppleBuildImage[];
  binaries: Array<{ path: string; images: AppleBuildImage[] }>;
}
interface ReadOptions {
  kind?: "binary" | "dsym";
  root?: string;
}
const invalid = () => new Error("invalid_apple_binary");
/** A DWARF entry rejected with one of these cannot hold a listed identity. */
const NOT_A_DSYM = new Set([
  "invalid_apple_binary",
  "unsupported_apple_architecture",
  "invalid_input_file",
]);
/**
 * At most eight detail lines per diagnostic list. Paths stay whole so the CLI
 * can redact a configured token before it caps the printed message.
 */
const bounded = (lines: string[]) =>
  lines.length > 8
    ? [...lines.slice(0, 8), `  and ${lines.length - 8} more`]
    : lines;
/** Names the file behind a bare failure code; other errors pass through. */
function named(error: unknown, path: string) {
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? new Error(`${error.message}: ${path}`)
    : error;
}
export async function withPath<T>(
  path: string,
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw named(error, path);
  }
}
const key = (image: AppleBuildImage) =>
  `${image.uuid}/${image.cpuType}/${image.cpuSubtype}`;
function architecture(
  cpu: number,
  subtype: number
): AppleBuildImage["architecture"] {
  if (cpu === 0x100000c) {
    if (subtype === 0 || subtype === 1) return "arm64";
    if (subtype === 2) return "arm64e";
  }
  if (cpu === 0x1000007) {
    if (subtype === 3) return "x86_64";
    if (subtype === 8) return "x86_64h";
  }
  throw new Error("unsupported_apple_architecture");
}
function unchanged(left: BigIntStats, right: BigIntStats) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
/** Header identities only; full DWARF verification remains the service's job. */
async function inspect(
  path: string,
  options: ReadOptions,
  hashContents = false
) {
  const input = resolve(path),
    root = options.root ?? (await realpath(dirname(input)));
  const canonical = await checkedRealPath(root, input);
  const file = await open(
    input,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw new Error("invalid_input_file");
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || before.size < 32n)
      throw invalid();
    const size = Number(before.size);
    async function read(position: number, length: number) {
      if (
        !Number.isSafeInteger(position) ||
        position < 0 ||
        length < 0 ||
        length > 1024 * 1024 ||
        position > size - length
      )
        throw invalid();
      const out = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await file.read(
          out,
          done,
          length - done,
          position + done
        );
        if (!bytesRead) throw invalid();
        done += bytesRead;
      }
      return out;
    }
    async function slice(
      start: number,
      length: number,
      declaredCpu?: number,
      declaredSubtype?: number
    ): Promise<AppleBuildImage> {
      if (length < 32) throw invalid();
      const header = await read(start, 32);
      // The currently supported Apple native contract is little-endian64.
      if (
        header.readUInt32LE(0) !== 0xfeedfacf ||
        header.readUInt32LE(28) !== 0
      )
        throw invalid();
      const cpu = header.readInt32LE(4),
        rawSubtype = header.readInt32LE(8),
        subtype = rawSubtype & 0xffffff;
      const arch = architecture(cpu, subtype),
        kind = header.readUInt32LE(12);
      if (
        declaredCpu !== undefined &&
        (cpu !== declaredCpu || rawSubtype !== declaredSubtype)
      )
        throw invalid();
      if (options.kind === "dsym" ? kind !== 10 : ![2, 6, 8].includes(kind))
        throw invalid();
      const count = header.readUInt32LE(16),
        commandBytes = header.readUInt32LE(20);
      if (
        !count ||
        count > 4096 ||
        count * 8 > commandBytes ||
        commandBytes > 1024 * 1024 ||
        commandBytes > length - 32
      )
        throw invalid();
      const commands = await read(start + 32, commandBytes);
      let offset = 0,
        uuid: string | undefined;
      for (let i = 0; i < count; i++) {
        if (offset > commands.length - 8) throw invalid();
        const command = commands.readUInt32LE(offset),
          bytes = commands.readUInt32LE(offset + 4);
        if (bytes < 8 || bytes % 8 || bytes > commands.length - offset)
          throw invalid();
        if (command === 0x19) {
          // LC_SEGMENT_64 and section_64 are still bounded header metadata.
          // Reject detectable truncation before any selected artifact uploads;
          // DWARF semantics remain the server processor's responsibility.
          if (bytes < 72) throw invalid();
          const sections = commands.readUInt32LE(offset + 64);
          if (bytes !== 72 + sections * 80) throw invalid();
          const vmAddress = commands.readBigUInt64LE(offset + 24),
            vmSize = commands.readBigUInt64LE(offset + 32),
            fileOffset = commands.readBigUInt64LE(offset + 40),
            fileSize = commands.readBigUInt64LE(offset + 48),
            sliceSize = BigInt(length);
          if (
            vmSize > (1n << 64n) - vmAddress ||
            fileOffset > sliceSize ||
            fileSize > sliceSize - fileOffset ||
            fileSize > vmSize
          )
            throw invalid();
          const segmentName = commands
            .subarray(offset + 8, offset + 24)
            .toString("ascii")
            .replace(/\0.*$/, "");
          for (let j = 0; j < sections; j++) {
            const section = offset + 72 + j * 80,
              address = commands.readBigUInt64LE(section + 32),
              size = commands.readBigUInt64LE(section + 40),
              position = BigInt(commands.readUInt32LE(section + 48)),
              relocationOffset = BigInt(commands.readUInt32LE(section + 56)),
              relocationBytes =
                BigInt(commands.readUInt32LE(section + 60)) * 8n,
              flags = commands.readUInt32LE(section + 64);
            if (
              address < vmAddress ||
              address > vmAddress + vmSize ||
              size > vmAddress + vmSize - address
            )
              throw invalid();
            const zeroFill = [1, 0xc, 0x12].includes(flags & 0xff);
            // dSYMs retain original code/data virtual ranges without their
            // bytes, even alongside a file-backed __eh_frame in __TEXT.
            const virtualOnly =
              kind === 10 &&
              position === 0n &&
              segmentName !== "__DWARF" &&
              !(flags & 0x02000000);
            if (
              !zeroFill &&
              !virtualOnly &&
              size > 0n &&
              (position < fileOffset ||
                position > fileOffset + fileSize ||
                size > fileOffset + fileSize - position)
            )
              throw invalid();
            if (
              relocationBytes > 0n &&
              (relocationOffset > sliceSize ||
                relocationBytes > sliceSize - relocationOffset)
            )
              throw invalid();
          }
        }
        if (command === 0x1b) {
          if (uuid !== undefined || bytes !== 24) throw invalid();
          const hex = commands
            .subarray(offset + 8, offset + 24)
            .toString("hex");
          if (/^0+$/.test(hex)) throw invalid();
          uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
            12,
            16
          )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
        offset += bytes;
      }
      if (offset !== commandBytes || !uuid) throw invalid();
      return { uuid, cpuType: cpu, cpuSubtype: subtype, architecture: arch };
    }
    const first = await read(0, 8),
      magic = first.readUInt32BE(0);
    const images: AppleBuildImage[] = [];
    if (first.readUInt32LE(0) === 0xfeedfacf) images.push(await slice(0, size));
    else {
      if (![0xcafebabe, 0xcafebabf, 0xbebafeca, 0xbfbafeca].includes(magic))
        throw invalid();
      const little = magic === 0xbebafeca || magic === 0xbfbafeca;
      const wide = magic === 0xcafebabf || magic === 0xbfbafeca;
      const count = little ? first.readUInt32LE(4) : first.readUInt32BE(4),
        stride = wide ? 32 : 20;
      if (!count || count > 8) throw invalid();
      const table = await read(8, count * stride),
        tableEnd = 8 + table.length;
      const u32 = (p: number) =>
        little ? table.readUInt32LE(p) : table.readUInt32BE(p);
      const i32 = (p: number) =>
        little ? table.readInt32LE(p) : table.readInt32BE(p);
      const u64 = (p: number) =>
        little ? table.readBigUInt64LE(p) : table.readBigUInt64BE(p);
      const ranges: Array<{ start: number; length: number }> = [];
      for (let i = 0; i < count; i++) {
        const p = i * stride,
          startBig = wide ? u64(p + 8) : BigInt(u32(p + 8));
        const lengthBig = wide ? u64(p + 16) : BigInt(u32(p + 12)),
          alignment = u32(p + (wide ? 24 : 16));
        if (
          startBig > BigInt(size) ||
          lengthBig > BigInt(size) ||
          alignment > 31 ||
          (wide && u32(p + 28) !== 0)
        )
          throw invalid();
        const start = Number(startBig),
          length = Number(lengthBig);
        if (
          start < tableEnd ||
          length < 32 ||
          start > size - length ||
          start % 2 ** alignment !== 0 ||
          ranges.some(
            (r) => start < r.start + r.length && r.start < start + length
          )
        )
          throw invalid();
        ranges.push({ start, length });
        images.push(await slice(start, length, i32(p), i32(p + 4)));
      }
    }
    if (new Set(images.map(key)).size !== images.length) throw invalid();
    let sha256: string | undefined;
    if (hashContents) {
      if (size > DSYM_MAX_BYTES) throw new Error("dsym_too_large");
      const hash = createHash("sha256"),
        buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (position < size) {
        const { bytesRead } = await file.read(
          buffer,
          0,
          Math.min(buffer.length, size - position),
          position
        );
        if (!bytesRead) throw new Error("source_map_changed");
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      sha256 = hash.digest("hex");
    }
    if (
      !unchanged(before, await file.stat({ bigint: true })) ||
      !unchanged(before, await stat(input, { bigint: true })) ||
      canonical !== (await checkedRealPath(root, input))
    )
      throw new Error("source_map_changed");
    return { images, sha256 };
  } finally {
    await file.close();
  }
}
export async function readAppleBinaryImages(
  path: string,
  options: ReadOptions = {}
): Promise<AppleBuildImage[]> {
  return (await inspect(path, options)).images;
}
export async function collectAppleBuild(options: {
  binaries: string[];
  dsymDir: string;
}): Promise<CollectedAppleBuild> {
  if (!options.binaries.length || options.binaries.length > 16)
    throw new Error(
      `apple_build_limit: list 1 to 16 binaries (got ${options.binaries.length})`
    );
  const root = await realpath(resolve(options.dsymDir));
  const binaries = [];
  for (const path of options.binaries)
    binaries.push({
      path: resolve(path),
      images: await withPath(resolve(path), () => readAppleBinaryImages(path)),
    });
  const expected = new Map(
    binaries.flatMap((b) =>
      b.images.map((image) => [key(image), image] as const)
    )
  );
  const candidates: Array<{ path: string; images: AppleBuildImage[] }> = [],
    skipped: string[] = [];
  let entries = 0,
    bundles = 0,
    scanned = 0;
  async function list(path: string) {
    return withPath(path, async () => {
      const canonical = await checkedRealPath(root, path),
        result = [];
      const dir = await opendir(canonical);
      for await (const entry of dir) {
        if (++entries > 1024)
          throw new Error(
            `apple_build_limit: more than 1024 directory entries under ${root}`
          );
        result.push(entry.name);
      }
      if (canonical !== (await checkedRealPath(root, path)))
        throw new Error("source_map_changed");
      return result.sort();
    });
  }
  for (const name of await list(root)) {
    if (!name.endsWith(".dSYM")) continue;
    scanned++;
    const directory = join(root, name, "Contents", "Resources", "DWARF");
    let matched = false;
    for (const entry of await list(directory)) {
      const path = join(directory, entry);
      let images: AppleBuildImage[];
      try {
        images = await readAppleBinaryImages(path, { root, kind: "dsym" });
      } catch (error) {
        // Unlisted companions (watchOS arm64_32), stray files and other
        // unsupported entries are not candidates. Path, race and I/O
        // failures still stop the build.
        if (!(error instanceof Error) || !NOT_A_DSYM.has(error.message))
          throw named(error, path);
        skipped.push(`  ${path} (${error.message})`);
        continue;
      }
      if (images.some((image) => expected.has(key(image)))) {
        candidates.push({ path, images });
        matched = true;
      }
    }
    // Unrelated bundles stay bounded by the directory-entry limit only.
    if (matched && ++bundles > 64)
      throw new Error(
        `apple_build_limit: more than 64 .dSYM bundles under ${root} hold a listed identity`
      );
  }
  const selected = new Map<string, LocalBuild>(),
    published = new Map<string, { sha: string; path: string }>();
  for (const candidate of candidates)
    await withPath(candidate.path, async () => {
      const inspected = await inspect(
        candidate.path,
        { root, kind: "dsym" },
        true
      );
      if (
        JSON.stringify(inspected.images) !== JSON.stringify(candidate.images)
      )
        throw new Error("source_map_changed");
      const local = await collectDsymBuild({ dwarfPath: candidate.path });
      await checkedRealPath(root, candidate.path);
      const sha = local.manifest.artifacts[0]!.mapSha256;
      if (sha !== inspected.sha256) throw new Error("source_map_changed");
      for (const image of inspected.images) {
        const previous = published.get(key(image));
        if (previous && previous.sha !== sha)
          throw new Error(
            `ambiguous_dsym_identity: ${image.architecture} ${image.uuid} is in different files ${previous.path} and ${candidate.path}`
          );
        if (!previous) published.set(key(image), { sha, path: candidate.path });
      }
      if (!selected.has(sha)) {
        if (selected.size === 8)
          throw new Error(
            "apple_build_limit: more than 8 distinct DWARF files match the listed binaries"
          );
        // Preserve the caller's common anchor, including the bundle parents.
        for (const roots of local.fileRoots!.values()) roots.mapRoot = root;
        selected.set(sha, local);
      }
    });
  const missing = new Map<string, string>();
  for (const binary of binaries)
    for (const image of binary.images)
      if (!published.has(key(image)) && !missing.has(key(image)))
        missing.set(
          key(image),
          `  ${image.architecture} ${image.uuid} in ${binary.path}`
        );
  if (missing.size)
    throw new Error(
      [
        `missing_matching_dsym: no DWARF file under ${root} matches these listed images (.dSYM bundles inspected: ${scanned}):`,
        ...bounded([...missing.values()]),
        ...(skipped.length
          ? [
              "Skipped files that are not supported 64-bit dSYMs:",
              ...bounded(skipped),
            ]
          : []),
      ].join("\n")
    );
  for (const binary of binaries)
    await withPath(binary.path, async () => {
      if (
        JSON.stringify(await readAppleBinaryImages(binary.path)) !==
        JSON.stringify(binary.images)
      )
        throw new Error("source_map_changed");
    });
  return {
    artifacts: [...selected.values()],
    images: [...expected.values()],
    binaries,
  };
}
