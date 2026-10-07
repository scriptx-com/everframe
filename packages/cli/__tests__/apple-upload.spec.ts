// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { uploadAppleBuild } from "../src/apple-upload.js";
import { main } from "../src/index.js";
import { dsym, macho, UUID_B } from "./apple-build-fixture.js";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-apple-upload-"));
  roots.push(root);
  const binaries = [join(root, "App"), join(root, "Framework")];
  await writeFile(binaries[0]!, macho());
  await writeFile(binaries[1]!, macho({ uuid: UUID_B, kind: 6 }));
  const files = [
    await dsym(root, "App"),
    await dsym(root, "Framework", macho({ uuid: UUID_B, kind: 10 })),
  ];
  return {
    root,
    binaries,
    files,
    options: {
      binaries,
      dsymDir: root,
      appId: "app",
      apiUrl: "http://localhost:12345/api/v1",
      token: "fixture-secret",
    },
  };
}
function server() {
  const builds = new Map<
    string,
    { sha: string; ready: boolean; available: boolean }
  >();
  let failed = false;
  const status = (id: string) => ({
    buildUuid: id,
    status: builds.get(id)!.ready ? "ready" : "uploading",
    artifacts: [
      {
        artifactUuid: "artifact",
        url: "dsym://apple/dwarf",
        available: builds.get(id)!.available,
      },
    ],
  });
  const hooks: {
    reject?: boolean;
    afterPut?: (count: number) => Promise<void>;
  } = {};
  let puts = 0;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer fixture-secret",
      });
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/source-map-builds") && init?.method === "POST") {
        const manifest = JSON.parse(String(init.body));
        expect(manifest.version).toBe(4);
        const id = "build-" + manifest.artifacts[0].mapSha256.slice(0, 12);
        if (!builds.has(id))
          builds.set(id, {
            sha: manifest.artifacts[0].mapSha256,
            ready: false,
            available: false,
          });
        return Response.json(status(id));
      }
      const id = path.split("/source-map-builds/")[1]!.split("/")[0]!;
      if (init?.method === "PUT") {
        if (hooks.reject && builds.size === 2 && !failed) {
          failed = true;
          return Response.json({ error: "invalid_api_token" }, { status: 401 });
        }
        builds.get(id)!.available = true;
        puts++;
        await hooks.afterPut?.(puts);
        return new Response(null, { status: 204 });
      }
      if (path.endsWith("/complete")) builds.get(id)!.ready = true;
      return Response.json(status(id));
    }
  );
  return { fetcher, builds, hooks, puts: () => puts };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});
it("uploads every selected file sequentially and retains bytes", async () => {
  const f = await fixture(),
    api = server(),
    before = await Promise.all(f.files.map((path) => readFile(path)));
  const result = await uploadAppleBuild(f.options, {
    fetch: api.fetcher,
    wait: async () => {},
  });
  expect(result.artifacts).toHaveLength(2);
  expect(result.artifacts.every((a) => a.status === "ready")).toBe(true);
  expect(result.images).toHaveLength(2);
  expect(await Promise.all(f.files.map((path) => readFile(path)))).toEqual(
    before
  );
  expect(api.puts()).toBe(2);
});
it("performs no network activity when one required binary lacks symbols", async () => {
  const f = await fixture(),
    api = server();
  await rm(f.files[1]!);
  await expect(
    uploadAppleBuild(f.options, { fetch: api.fetcher })
  ).rejects.toThrow();
  expect(api.fetcher).not.toHaveBeenCalled();
});
it("fails a partially uploaded build and resumes its immutable first artifact on retry", async () => {
  const f = await fixture(),
    api = server();
  api.hooks.reject = true;
  await expect(
    uploadAppleBuild(f.options, { fetch: api.fetcher, wait: async () => {} })
  ).rejects.toThrow(/invalid_api_token/);
  expect([...api.builds.values()].filter((b) => b.ready)).toHaveLength(1);
  const result = await uploadAppleBuild(f.options, {
    fetch: api.fetcher,
    wait: async () => {},
  });
  expect(result.artifacts.every((a) => a.status === "ready")).toBe(true);
  expect(api.puts()).toBe(2);
});
it.each(["binary", "earlier-dsym"])(
  "refuses success if %s changes while later artifacts upload",
  async (kind) => {
    const f = await fixture(),
      api = server();
    api.hooks.afterPut = async (count) => {
      if (count !== 2) return;
      await writeFile(
        kind === "binary" ? f.binaries[0]! : f.files[0]!,
        macho({ uuid: UUID_B, kind: kind === "binary" ? 2 : 10 })
      );
    };
    await expect(
      uploadAppleBuild(f.options, { fetch: api.fetcher, wait: async () => {} })
    ).rejects.toThrow("source_map_changed");
  }
);
it("accepts repeated CLI binary options and prints success only after all files are ready", async () => {
  const f = await fixture(),
    api = server();
  vi.stubGlobal("fetch", api.fetcher);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  expect(
    await main(
      [
        "dsym",
        "upload-build",
        "--app-id",
        "app",
        "--binary",
        f.binaries[0]!,
        "--binary",
        f.binaries[1]!,
        "--dsym-dir",
        f.root,
      ],
      {
        EVERFRAME_API_TOKEN: "fixture-secret",
        EVERFRAME_API_URL: f.options.apiUrl,
      }
    )
  ).toBe(0);
  expect(api.puts()).toBe(2);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("2 dSYM files"));
});
it("prints command help without credentials and rejects incomplete arguments before network", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {}),
    error = vi.spyOn(console, "error").mockImplementation(() => {}),
    fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  expect(await main(["dsym", "upload-build", "--help"], {})).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining("upload-build"));
  expect(await main(["dsym", "upload-build", "--app-id", "app"], {})).toBe(1);
  expect(error).toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it("redacts a configured token even from a local filesystem diagnostic", async () => {
  const f = await fixture(),
    error = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(
    await main(
      [
        "dsym",
        "upload-build",
        "--app-id",
        "app",
        "--binary",
        join(f.root, "fixture-secret"),
        "--dsym-dir",
        f.root,
      ],
      { EVERFRAME_API_TOKEN: "fixture-secret" }
    )
  ).toBe(1);
  expect(error.mock.calls.flat().join(" ")).not.toContain("fixture-secret");
});
