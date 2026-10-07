// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  mkdtemp,
  writeFile,
  rm,
  symlink,
  truncate,
  mkdir,
  rename,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readAppleBinaryImages,
  collectAppleBuild,
} from "../src/apple-build.js";
import {
  macho,
  segmented,
  universal,
  dsym,
  UUID_A,
  UUID_B,
} from "./apple-build-fixture.js";
const hooks = vi.hoisted(() => ({
  onRead: undefined as undefined | ((path: string) => Promise<void>),
}));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>(
    "node:fs/promises"
  );
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const file = await actual.open(...args),
        read = file.read;
      Object.defineProperty(file, "read", {
        configurable: true,
        value: async (...readArgs: unknown[]) => {
          const result = await Reflect.apply(read, file, readArgs);
          await hooks.onRead?.(String(args[0]));
          return result;
        },
      });
      return file;
    },
  };
});
const roots: string[] = [];
async function fixture(bytes: Buffer = macho()) {
  const root = await mkdtemp(join(tmpdir(), "everframe-apple-build-"));
  roots.push(root);
  const binary = join(root, "App");
  await writeFile(binary, bytes);
  return { root, binary };
}
afterEach(async () => {
  hooks.onRead = undefined;
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
it.each([
  ["truncated file", (b: Buffer) => b.subarray(0, 208)],
  [
    "short segment command",
    (b: Buffer) => {
      b.writeUInt32LE(64, 60);
      return b;
    },
  ],
  [
    "section count",
    (b: Buffer) => {
      b.writeUInt32LE(0xffffffff, 120);
      return b;
    },
  ],
  [
    "segment range overflow",
    (b: Buffer) => {
      b.writeBigUInt64LE(0xffffffffffffffffn, 96);
      return b;
    },
  ],
  [
    "segment virtual overflow",
    (b: Buffer) => {
      b.writeBigUInt64LE(0xffffffffffffffffn, 80);
      return b;
    },
  ],
  [
    "section beyond segment",
    (b: Buffer) => {
      b.writeBigUInt64LE(129n, 168);
      return b;
    },
  ],
  [
    "section before segment",
    (b: Buffer) => {
      b.writeUInt32LE(255, 176);
      return b;
    },
  ],
  [
    "section virtual overflow",
    (b: Buffer) => {
      b.writeBigUInt64LE(0xffffffffffffffffn, 160);
      return b;
    },
  ],
  [
    "relocations beyond slice",
    (b: Buffer) => {
      b.writeUInt32LE(508, 184);
      b.writeUInt32LE(1, 188);
      return b;
    },
  ],
  [
    "missing DWARF bytes",
    (b: Buffer) => {
      b.writeBigUInt64LE(0n, 104);
      b.writeUInt32LE(0, 176);
      return b;
    },
  ],
] as const)(
  "rejects locally observable malformed segment/section: %s",
  async (_name, mutate) => {
    const f = await fixture(mutate(segmented()));
    await expect(
      readAppleBinaryImages(f.binary, { kind: "dsym" })
    ).rejects.toThrow(/invalid_apple_binary/);
  }
);
it("bounds segment ranges to the fat slice even when trailing container bytes exist", async () => {
  const f = await fixture(universal([segmented().subarray(0, 208)]));
  await expect(
    readAppleBinaryImages(f.binary, { kind: "dsym" })
  ).rejects.toThrow(/invalid_apple_binary/);
});
it("accepts file-backed segments and virtual-only dSYM sections in a partly file-backed segment", async () => {
  const b = segmented(),
    f = await fixture(b);
  expect(await readAppleBinaryImages(f.binary, { kind: "dsym" })).toHaveLength(
    1
  );
  b.fill(0, 64, 80);
  b.write("__TEXT", 64);
  b.writeBigUInt64LE(4096n, 168);
  b.writeUInt32LE(0, 176);
  await writeFile(f.binary, b);
  expect(await readAppleBinaryImages(f.binary, { kind: "dsym" })).toHaveLength(
    1
  );
});
it.each([1, 0xc, 0x12])(
  "accepts executable zero-fill section type %s without file bytes",
  async (flags) => {
    const b = segmented({ kind: 2 });
    b.writeBigUInt64LE(4096n, 168);
    b.writeUInt32LE(0, 176);
    b.writeUInt32LE(flags, 192);
    const f = await fixture(b);
    expect(await readAppleBinaryImages(f.binary)).toHaveLength(1);
  }
);
it.each([
  [0x100000c, 0, "arm64"],
  [0x100000c, 1, "arm64"],
  [0x100000c, 0x80000002, "arm64e"],
  [0x1000007, 3, "x86_64"],
  [0x1000007, 8, "x86_64h"],
] as const)(
  "reads exact supported CPU identity %s/%s",
  async (cpu, subtype, architecture) => {
    const f = await fixture(macho({ cpu, subtype }));
    expect(await readAppleBinaryImages(f.binary)).toEqual([
      {
        uuid: UUID_A,
        cpuType: cpu,
        cpuSubtype: subtype & 0xffffff,
        architecture,
      },
    ]);
  }
);
it.each([
  { wide: false, little: false },
  { wide: true, little: false },
  { wide: false, little: true },
  { wide: true, little: true },
])("reads bounded universal wrappers %j", async (options) => {
  const f = await fixture(
    universal(
      [macho(), macho({ uuid: UUID_B, cpu: 0x1000007, subtype: 3 })],
      options
    )
  );
  expect((await readAppleBinaryImages(f.binary)).map((i) => i.uuid)).toEqual([
    UUID_A,
    UUID_B,
  ]);
});
it.each([
  "truncated",
  "big-thin",
  "unsupported-cpu",
  "missing-uuid",
  "zero-uuid",
  "duplicate-uuid",
  "command-overflow",
  "short-command",
  "bad-kind",
  "fat-overlap",
  "fat-cpu",
  "fat-unsafe-offset",
  "fat-reserved",
  "duplicate-slice",
])("rejects %s instead of guessing image identity", async (kind) => {
  let b = macho();
  if (kind === "truncated") b = b.subarray(0, 40);
  if (kind === "big-thin") b = macho({ big: true });
  if (kind === "unsupported-cpu") b = macho({ cpu: 12 });
  if (kind === "missing-uuid") b.writeUInt32LE(1, 32);
  if (kind === "zero-uuid") b.fill(0, 40);
  if (kind === "duplicate-uuid") {
    b = Buffer.concat([b, b.subarray(32)]);
    b.writeUInt32LE(2, 16);
    b.writeUInt32LE(48, 20);
  }
  if (kind === "command-overflow") b.writeUInt32LE(0xffffffff, 20);
  if (kind === "short-command") b.writeUInt32LE(4, 36);
  if (kind === "bad-kind") b = macho({ kind: 10 });
  if (kind === "fat-overlap") {
    b = universal([macho(), macho({ uuid: UUID_B, subtype: 1 })]);
    b.writeUInt32BE(4096, 36);
  }
  if (kind === "fat-cpu") {
    b = universal([macho()]);
    b.writeUInt32BE(0x1000007, 8);
  }
  if (kind === "fat-unsafe-offset") {
    b = universal([macho()], { wide: true });
    b.writeBigUInt64BE(1n << 63n, 16);
  }
  if (kind === "fat-reserved") {
    b = universal([macho()], { wide: true });
    b.writeUInt32BE(1, 36);
  }
  if (kind === "duplicate-slice") b = universal([macho(), macho()]);
  const f = await fixture(b);
  await expect(readAppleBinaryImages(f.binary)).rejects.toThrow(
    /apple|unsupported/
  );
});
it("reads headers without buffering the executable body", async () => {
  const f = await fixture();
  await truncate(f.binary, 256 * 1024 * 1024);
  expect((await readAppleBinaryImages(f.binary))[0]!.uuid).toBe(UUID_A);
});
it("rejects directories and escaping final symlinks", async () => {
  const f = await fixture(),
    other = await fixture();
  const link = join(f.root, "link");
  await symlink(other.binary, link);
  await expect(readAppleBinaryImages(link)).rejects.toThrow(/symlink/);
  await expect(readAppleBinaryImages(f.root)).rejects.toThrow(/input_file/);
});
it("collects app and framework symbols before any upload and deduplicates exact copied files", async () => {
  const f = await fixture(),
    framework = join(f.root, "Framework");
  await writeFile(framework, macho({ uuid: UUID_B, kind: 6 }));
  await dsym(f.root, "App");
  await dsym(f.root, "AppCopy");
  await dsym(f.root, "Framework", macho({ uuid: UUID_B, kind: 10 }));
  const result = await collectAppleBuild({
    binaries: [f.binary, framework],
    dsymDir: f.root,
  });
  expect(result.artifacts).toHaveLength(2);
  expect(result.images).toHaveLength(2);
  expect(result.artifacts.every((a) => a.manifest.version === 4)).toBe(true);
});
it.each(["missing", "wrong-uuid", "wrong-cpu", "ambiguous", "non-dsym"])(
  "fails incomplete builds (%s)",
  async (kind) => {
    const f = await fixture();
    if (kind === "wrong-uuid")
      await dsym(f.root, "Other", macho({ kind: 10, uuid: UUID_B }));
    if (kind === "wrong-cpu")
      await dsym(f.root, "Other", macho({ kind: 10, subtype: 1 }));
    if (kind === "non-dsym") await dsym(f.root, "App", macho());
    if (kind === "ambiguous") {
      await dsym(f.root, "App");
      const b = Buffer.concat([
        macho({ kind: 10 }),
        Buffer.from("different bytes"),
      ]);
      await dsym(f.root, "Conflict", b);
    }
    await expect(
      collectAppleBuild({ binaries: [f.binary], dsymDir: f.root })
    ).rejects.toThrow(/missing|ambiguous|apple/);
  }
);
it("does not follow a dSYM bundle outside its declared directory", async () => {
  const f = await fixture(),
    other = await fixture();
  await dsym(other.root, "App");
  await symlink(join(other.root, "App.dSYM"), join(f.root, "App.dSYM"));
  await expect(
    collectAppleBuild({ binaries: [f.binary], dsymDir: f.root })
  ).rejects.toThrow(/symlink/);
});
it("bounds declared binaries, candidate bundles and directory entries", async () => {
  const f = await fixture();
  await expect(
    collectAppleBuild({ binaries: [], dsymDir: f.root })
  ).rejects.toThrow(/limit/);
  await expect(
    collectAppleBuild({ binaries: Array(17).fill(f.binary), dsymDir: f.root })
  ).rejects.toThrow(/limit/);
  await Promise.all(
    Array.from({ length: 65 }, (_, i) => dsym(f.root, "Candidate" + i))
  );
  await expect(
    collectAppleBuild({ binaries: [f.binary], dsymDir: f.root })
  ).rejects.toThrow(/limit/);
  const second = await fixture();
  await Promise.all(
    Array.from({ length: 1025 }, (_, i) =>
      mkdir(join(second.root, "entry" + i))
    )
  );
  await expect(
    collectAppleBuild({ binaries: [second.binary], dsymDir: second.root })
  ).rejects.toThrow(/limit/);
});

it.each(["modify", "replace"])(
  "rejects a file that changes while its headers are being read (%s)",
  async (kind) => {
    const f = await fixture();
    hooks.onRead = async () => {
      hooks.onRead = undefined;
      if (kind === "replace") await rename(f.binary, f.binary + ".old");
      await writeFile(f.binary, macho({ uuid: UUID_B }));
    };
    await expect(readAppleBinaryImages(f.binary)).rejects.toThrow(
      "source_map_changed"
    );
  }
);
it("checks expected binaries again after collecting dSYMs", async () => {
  const f = await fixture();
  await dsym(f.root, "App");
  hooks.onRead = async (path) => {
    if (!path.includes(".dSYM")) return;
    hooks.onRead = undefined;
    await writeFile(f.binary, macho({ uuid: UUID_B }));
  };
  await expect(
    collectAppleBuild({ binaries: [f.binary], dsymDir: f.root })
  ).rejects.toThrow("source_map_changed");
});
it("does not block on a FIFO masquerading as a binary", async () => {
  const f = await fixture(),
    fifo = join(f.root, "pipe");
  execFileSync("/usr/bin/mkfifo", [fifo]);
  await expect(readAppleBinaryImages(fifo)).rejects.toThrow(
    "invalid_input_file"
  );
});
it("rejects oversized raw DWARF and more than eight selected files", async () => {
  const f = await fixture(),
    path = await dsym(f.root, "App");
  await truncate(path, 64 * 1024 * 1024 + 1);
  await expect(
    collectAppleBuild({ binaries: [f.binary], dsymDir: f.root })
  ).rejects.toThrow("dsym_too_large");
  const second = await fixture(),
    binaries = [];
  for (let i = 0; i < 9; i++) {
    const uuid = UUID_A.slice(0, 28) + String(i).padStart(8, "0"),
      binary = join(second.root, "Binary" + i);
    await writeFile(binary, macho({ uuid }));
    binaries.push(binary);
    await dsym(second.root, "Binary" + i, macho({ uuid, kind: 10 }));
  }
  await expect(
    collectAppleBuild({ binaries, dsymDir: second.root })
  ).rejects.toThrow("apple_build_limit");
});
