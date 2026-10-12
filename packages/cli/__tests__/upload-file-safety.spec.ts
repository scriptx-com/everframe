// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import {
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { collectDsymBuild } from "../src/dsym.js";
import { collectR8Build } from "../src/r8.js";
import { uploadCollectedBuild } from "../src/upload.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    readFile: vi.fn(actual.readFile),
  };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const roots: string[] = [];
afterEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(readFile).mockReset().mockImplementation(actual.readFile);
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// R8 mappings use the buffered reader; raw dSYMs use the snapshot reader.
const limits = { r8: 32 * 1024 * 1024, dsym: 512 * 1024 * 1024 };
type Kind = keyof typeof limits;
const cases = (["r8", "dsym"] as const).flatMap((kind) =>
  [false, true].map((ready) => [kind, ready] as const),
);

async function fixture(kind: Kind, size?: number) {
  const root = await mkdtemp(join(tmpdir(), "everframe-upload-safety-"));
  roots.push(root);
  const mappingPath = join(root, kind === "r8" ? "mapping.txt" : "App");
  await writeFile(
    mappingPath,
    size === undefined
      ? "com.example.Real -> a:\n    void run() -> a\n"
      : Buffer.alloc(size, 0x20),
  );
  const local =
    kind === "r8"
      ? await collectR8Build({ mappingId: "ci-123", mappingPath })
      : await collectDsymBuild({ dwarfPath: mappingPath });
  const methods: string[] = [];
  return {
    mappingPath,
    local,
    methods,
    upload: (reserved: () => Promise<void>, ready = false) =>
      uploadCollectedBuild(
        local,
        {
          appId: "app",
          root,
          apiUrl: "https://api.example.test/api/v1",
          token: "test-token",
          deleteAfterUpload: false,
        },
        {
          fetch: async (_input, init = {}) => {
            methods.push(String(init.method));
            if (methods.length === 1) await reserved();
            return Response.json({
              buildUuid: "build",
              status: ready ? "ready" : "uploading",
              artifacts: [
                {
                  artifactUuid: "artifact",
                  url: local.manifest.artifacts[0]!.url,
                  available: ready,
                },
              ],
            });
          },
        },
      ),
  };
}

it.each(cases)(
  "rejects a replacement FIFO promptly without PUT (%s, ready=%s)",
  async (kind, ready) => {
    const f = await fixture(kind);
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        f.upload(async () => {
          await unlink(f.mappingPath);
          execFileSync("mkfifo", [f.mappingPath]);
          // Release a regressed blocking open so a RED test cannot strand a worker.
          watchdog = setTimeout(() => {
            timedOut = true;
            closeSync(
              openSync(f.mappingPath, constants.O_RDWR | constants.O_NONBLOCK),
            );
          }, 500);
        }, ready),
      ).rejects.toThrow("source_map_changed");
      expect(
        timedOut,
        "mapping rejection must not wait for a FIFO writer",
      ).toBe(false);
      expect(f.methods).toEqual(["POST"]);
    } finally {
      clearTimeout(watchdog);
    }
  },
);

it.each(cases)(
  "rejects a replacement directory of the declared size without PUT (%s, ready=%s)",
  async (kind, ready) => {
    // Matching sizes leave the descriptor type check as the only defence.
    const directory = await mkdtemp(join(tmpdir(), "everframe-upload-dir-"));
    roots.push(directory);
    await writeFile(join(directory, "entry"), "");
    const f = await fixture(kind, (await stat(directory)).size);
    await expect(
      f.upload(async () => {
        await unlink(f.mappingPath);
        await rename(directory, f.mappingPath);
      }, ready),
    ).rejects.toThrow("source_map_changed");
    expect(f.methods).toEqual(["POST"]);
  },
);

it.each(cases)(
  "rejects an oversized replacement before buffering (%s, ready=%s)",
  async (kind, ready) => {
    const f = await fixture(kind);
    await expect(
      f.upload(async () => {
        await truncate(f.mappingPath, limits[kind] + 1);
        // An unbounded whole-file read would allocate before checking its length.
        vi.mocked(readFile).mockRejectedValue(
          new Error("unbounded_mapping_read"),
        );
      }, ready),
    ).rejects.toThrow("source_map_changed");
    expect(f.methods).toEqual(["POST"]);
  },
);

it.each(cases)(
  "rejects a same-size rewrite without PUT (%s, ready=%s)",
  async (kind, ready) => {
    const f = await fixture(kind);
    await expect(
      f.upload(
        () =>
          writeFile(
            f.mappingPath,
            Buffer.alloc(f.local.manifest.artifacts[0]!.mapBytes, 0x2a),
          ),
        ready,
      ),
    ).rejects.toThrow("source_map_changed");
    expect(f.methods).toEqual(["POST"]);
  },
);

it.each(cases)(
  "bounds a mapping that grows after descriptor stat (%s, ready=%s)",
  async (kind, ready) => {
    const f = await fixture(kind);
    let readBytes = 0;
    let grew = false;
    await expect(
      f.upload(async () => {
        vi.mocked(readFile).mockRejectedValue(
          new Error("unbounded_mapping_read"),
        );
        vi.mocked(open).mockImplementation(async (...args) => {
          const handle = await actual.open(...args);
          const originalStat = handle.stat.bind(handle);
          vi.spyOn(handle, "stat").mockImplementation(async () => {
            const metadata = await originalStat();
            if (!grew) {
              grew = true;
              await truncate(f.mappingPath, limits[kind] + 1);
            }
            return metadata;
          });
          const originalRead = handle.read.bind(handle);
          vi.spyOn(handle, "read").mockImplementation(
            async (...readArgs: Parameters<typeof handle.read>) => {
              const result = await originalRead(...readArgs);
              readBytes += result.bytesRead;
              return result;
            },
          );
          return handle;
        });
      }, ready),
    ).rejects.toThrow("source_map_changed");
    expect(grew).toBe(true);
    expect(readBytes).toBeLessThanOrEqual(
      f.local.manifest.artifacts[0]!.mapBytes + 1,
    );
    expect(f.methods).toEqual(["POST"]);
  },
);
