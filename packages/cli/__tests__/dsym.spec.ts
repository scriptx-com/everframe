// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectDsymBuild } from "../src/dsym.js";
import { main } from "../src/index.js";
import { uploadCollectedBuild } from "../src/upload.js";
const roots: string[] = [];
const url = "dsym://apple/dwarf";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-dsym-"));
  roots.push(root);
  const path = join(root, "App");
  const bytes = Buffer.from("synthetic raw dwarf bytes");
  await writeFile(path, bytes);
  return { root, path, bytes };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
describe("raw dSYM collection and upload", () => {
  it("hashes one raw file without accepting a caller build identity", async () => {
    const f = await fixture();
    const sha = createHash("sha256").update(f.bytes).digest("hex");
    const local = await collectDsymBuild({ dwarfPath: f.path });
    expect(local.manifest).toEqual({
      version: 4,
      runtime: "apple",
      platform: "apple",
      buildId: "dsym:" + sha,
      artifacts: [{ url, mapSha256: sha, mapBytes: f.bytes.length }],
    });
    expect(local.mapPaths.get(url)).toBe(f.path);
    expect(local.generatedPaths).toBeUndefined();
    expect(await readFile(f.path)).toEqual(f.bytes);
  });
  it("rejects empty, oversized, directory and escaping symlink inputs", async () => {
    const f = await fixture();
    await writeFile(f.path, "");
    await expect(collectDsymBuild({ dwarfPath: f.path })).rejects.toThrow(
      "dsym_too_large"
    );
    await truncate(f.path, 64 * 1024 * 1024 + 1);
    await expect(collectDsymBuild({ dwarfPath: f.path })).rejects.toThrow(
      "dsym_too_large"
    );
    const dir = join(f.root, "bundle");
    await mkdir(dir);
    await expect(collectDsymBuild({ dwarfPath: dir })).rejects.toThrow(
      "invalid_input_file"
    );
    const outside = await fixture();
    const link = join(f.root, "linked");
    await symlink(outside.path, link);
    await expect(collectDsymBuild({ dwarfPath: link })).rejects.toThrow(
      "symlink_escapes_root"
    );
  });
  it("uploads and retries exact bytes, completes, and retains the local file", async () => {
    const f = await fixture();
    const local = await collectDsymBuild({ dwarfPath: f.path });
    const status = (ready = false) => ({
      buildUuid: "build",
      status: ready ? "ready" : "uploading",
      artifacts: [{ artifactUuid: "artifact", url, available: ready }],
    });
    let puts = 0;
    const fetcher = vi.fn(
      async (address: string | URL | Request, init?: RequestInit) => {
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({
          authorization: "Bearer test-token",
        });
        if (init?.method === "PUT") {
          expect(Buffer.from(init.body as Uint8Array)).toEqual(f.bytes);
          if (++puts === 1) return new Response("{}", { status: 503 });
          return new Response(null, { status: 204 });
        }
        return Response.json(status(String(address).endsWith("/complete")));
      }
    );
    const result = await uploadCollectedBuild(
      local,
      {
        appId: "app",
        root: f.root,
        apiUrl: "http://127.0.0.1/api/v1",
        token: "test-token",
        deleteAfterUpload: false,
      },
      { fetch: fetcher, wait: async () => {} }
    );
    expect(result.status).toBe("ready");
    expect(puts).toBe(2);
    expect(await readFile(f.path)).toEqual(f.bytes);
  });
  it("verifies ready native artifacts larger than the legacy32MiB map limit", async () => {
    const f = await fixture();
    await truncate(f.path, 32 * 1024 * 1024 + 1);
    const local = await collectDsymBuild({ dwarfPath: f.path });
    const fetcher = vi.fn(async () =>
      Response.json({
        buildUuid: "build",
        status: "ready",
        artifacts: [{ artifactUuid: "artifact", url, available: true }],
      })
    );
    expect(
      (
        await uploadCollectedBuild(
          local,
          {
            appId: "app",
            root: f.root,
            apiUrl: "http://127.0.0.1/api/v1",
            token: "test-token",
            deleteAfterUpload: false,
          },
          { fetch: fetcher }
        )
      ).status
    ).toBe("ready");
    expect(local.manifest.artifacts[0]?.mapBytes).toBe(32 * 1024 * 1024 + 1);
  });
  it("rejects changed bytes and destructive cleanup", async () => {
    const f = await fixture();
    const local = await collectDsymBuild({ dwarfPath: f.path });
    const fetcher = vi.fn(async () =>
      Response.json({
        buildUuid: "build",
        status: "ready",
        artifacts: [{ artifactUuid: "artifact", url, available: true }],
      })
    );
    const options = {
      appId: "app",
      root: f.root,
      apiUrl: "http://127.0.0.1/api/v1",
      token: "test-token",
      deleteAfterUpload: false,
    };
    await writeFile(f.path, Buffer.alloc(f.bytes.length, 42));
    await expect(
      uploadCollectedBuild(local, options, { fetch: fetcher })
    ).rejects.toThrow("source_map_changed");
    await expect(
      uploadCollectedBuild(
        local,
        { ...options, deleteAfterUpload: true },
        { fetch: fetcher }
      )
    ).rejects.toThrow("delete_after_upload_unsupported");
  });
  it("routes CLI help and reports required options without revealing credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["dsym", "upload", "--help"], {})).toBe(0);
    expect(log.mock.calls.flat().join(" ")).toContain("--dwarf");
    expect(
      await main(["dsym", "upload"], { EVERFRAME_API_TOKEN: "secret-value" })
    ).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain(
      "missing_required_option"
    );
    expect(error.mock.calls.flat().join(" ")).not.toContain("secret-value");
  });
});
