// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from "node:child_process";
import { constants, closeSync, openSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  rm,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-upload-safety-"));
  roots.push(root);
  const mappingPath = join(root, "mapping.txt");
  await writeFile(mappingPath, "com.example.Real -> a:\n    void run() -> a\n");
  const local = await collectR8Build({ mappingId: "ci-123", mappingPath });
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

it.each([false, true])(
  "rejects a replacement FIFO promptly without PUT (ready=%s)",
  async (ready) => {
    const f = await fixture();
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

it("rejects a replacement directory without PUT", async () => {
  const f = await fixture();
  await expect(
    f.upload(async () => {
      await unlink(f.mappingPath);
      await mkdir(f.mappingPath);
    }),
  ).rejects.toThrow("source_map_changed");
  expect(f.methods).toEqual(["POST"]);
});

it.each([false, true])(
  "rejects an oversized replacement before buffering (ready=%s)",
  async (ready) => {
    const f = await fixture();
    await expect(
      f.upload(async () => {
        await truncate(f.mappingPath, 32 * 1024 * 1024 + 1);
        // An unbounded whole-file read would allocate before checking its length.
        vi.mocked(readFile).mockRejectedValue(
          new Error("unbounded_mapping_read"),
        );
      }, ready),
    ).rejects.toThrow("source_map_changed");
    expect(f.methods).toEqual(["POST"]);
  },
);

it.each([false, true])(
  "bounds a mapping that grows after descriptor stat (ready=%s)",
  async (ready) => {
    const f = await fixture();
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
              await truncate(f.mappingPath, 32 * 1024 * 1024 + 1);
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
