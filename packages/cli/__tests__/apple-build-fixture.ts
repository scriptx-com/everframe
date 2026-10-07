// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
export const UUID_A = "01234567-89ab-cdef-0123-456789abcdef";
export const UUID_B = "fedcba98-7654-3210-fedc-ba9876543210";
// Header-only fixtures, not executable programs or verified DWARF.
export function macho({
  uuid = UUID_A,
  cpu = 0x100000c,
  subtype = 0,
  kind = 2,
  big = false,
} = {}) {
  const b = Buffer.alloc(56);
  const u32 = (value: number, offset: number) =>
    big
      ? b.writeUInt32BE(value >>> 0, offset)
      : b.writeUInt32LE(value >>> 0, offset);
  u32(0xfeedfacf, 0);
  u32(cpu, 4);
  u32(subtype, 8);
  u32(kind, 12);
  u32(1, 16);
  u32(24, 20);
  u32(0x1b, 32);
  u32(24, 36);
  Buffer.from(uuid.replaceAll("-", ""), "hex").copy(b, 40);
  return b;
}
export function universal(
  slices: Buffer[],
  { wide = false, little = false } = {}
) {
  const size = wide ? 32 : 20,
    first = 4096,
    b = Buffer.alloc(first * (slices.length + 1));
  const u32 = (v: number, o: number) =>
    little ? b.writeUInt32LE(v >>> 0, o) : b.writeUInt32BE(v >>> 0, o);
  const u64 = (v: bigint, o: number) =>
    little ? b.writeBigUInt64LE(v, o) : b.writeBigUInt64BE(v, o);
  u32(wide ? 0xcafebabf : 0xcafebabe, 0);
  u32(slices.length, 4);
  slices.forEach((s, i) => {
    const p = 8 + i * size,
      start = first * (i + 1);
    u32(s.readUInt32LE(4), p);
    u32(s.readUInt32LE(8), p + 4);
    if (wide) {
      u64(BigInt(start), p + 8);
      u64(BigInt(s.length), p + 16);
      u32(12, p + 24);
    } else {
      u32(start, p + 8);
      u32(s.length, p + 12);
      u32(12, p + 16);
    }
    s.copy(b, start);
  });
  return b;
}
export async function dsym(
  root: string,
  name: string,
  bytes = macho({ kind: 10 })
) {
  const dir = join(root, `${name}.dSYM`, "Contents", "Resources", "DWARF");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}
// One segment and section with real file-range metadata; payload is synthetic.
export function segmented({ uuid = UUID_A, kind = 10 } = {}) {
  const b = Buffer.alloc(512);
  macho({ uuid, kind }).copy(b);
  b.writeUInt32LE(2, 16);
  b.writeUInt32LE(176, 20);
  b.writeUInt32LE(0x19, 56);
  b.writeUInt32LE(152, 60);
  b.write("__DWARF", 64);
  b.writeBigUInt64LE(0x100000000n, 80);
  b.writeBigUInt64LE(8192n, 88);
  b.writeBigUInt64LE(256n, 96);
  b.writeBigUInt64LE(128n, 104);
  b.writeUInt32LE(1, 120);
  b.write("__debug_info", 128);
  b.write("__DWARF", 144);
  b.writeBigUInt64LE(0x100000000n, 160);
  b.writeBigUInt64LE(128n, 168);
  b.writeUInt32LE(256, 176);
  return b;
}
