// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { R8_ASSET_URL } from "@everframe/protocol";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/index.js";
import { collectR8Build } from "../src/r8.js";
import {
  uploadCollectedBuild,
  type UploadDependencies,
} from "../src/upload.js";

const appId = "00000000-0000-4000-8000-000000000001";
const buildUuid = "00000000-0000-4000-8000-000000000002";
const artifactUuid = "00000000-0000-4000-8000-000000000003";
const token = "evf_api_private-r8-secret";

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-r8-"));
  const mappingPath = join(root, "mapping.txt");
  const mapping = Buffer.from(
    "com.example.RealName -> a:\n    void launch() -> a\n",
  );
  await writeFile(mappingPath, mapping);
  return { root, mappingPath, mapping };
}

function status(state: "uploading" | "ready", available: boolean) {
  return {
    buildUuid,
    status: state,
    artifacts: [{ artifactUuid, url: R8_ASSET_URL, available }],
  };
}

describe("collectR8Build", () => {
  it("collects one exact map-only V3 artifact without changing its bytes", async () => {
    const f = await fixture();
    const before = await readFile(f.mappingPath);

    const local = await collectR8Build({
      mappingId: "ci-123",
      mappingPath: f.mappingPath,
    });

    expect(local.manifest).toEqual({
      version: 3,
      runtime: "r8",
      platform: "android",
      buildId: "ci-123",
      artifacts: [
        {
          url: "r8://android/mapping.txt",
          mapSha256: sha(f.mapping),
          mapBytes: f.mapping.length,
        },
      ],
    });
    expect(local.manifest.artifacts[0]).not.toHaveProperty("generatedSha256");
    expect(local.generatedPaths).toBeUndefined();
    expect(local.mapPaths.get(R8_ASSET_URL)).toBe(f.mappingPath);
    expect(local.fileRoots?.get(R8_ASSET_URL)).toEqual({
      mapRoot: await realpath(f.root),
    });
    expect(await readFile(f.mappingPath)).toEqual(before);
  });

  it.each([
    "",
    ".mapping",
    "mapping/id",
    "ci-123\n",
    `a${"b".repeat(128)}`,
  ])("rejects invalid exact mapping ID %j", async (mappingId) => {
    const f = await fixture();
    await expect(
      collectR8Build({ mappingId, mappingPath: f.mappingPath }),
    ).rejects.toThrow();
  });

  it("rejects a symlink escaping the mapping directory", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "everframe-r8-outside-"));
    const outsideMapping = join(outside, "mapping.txt");
    await writeFile(outsideMapping, f.mapping);
    const linked = join(f.root, "linked-mapping.txt");
    await symlink(outsideMapping, linked);

    await expect(
      collectR8Build({ mappingId: "ci-123", mappingPath: linked }),
    ).rejects.toThrow("symlink_escapes_root");
  });

  it("rejects nonregular and empty mapping inputs", async () => {
    const f = await fixture();
    const directory = join(f.root, "mapping-dir");
    await mkdir(directory);
    await expect(
      collectR8Build({ mappingId: "ci-123", mappingPath: directory }),
    ).rejects.toThrow("invalid_input_file");

    await writeFile(f.mappingPath, Buffer.alloc(0));
    await expect(
      collectR8Build({ mappingId: "ci-123", mappingPath: f.mappingPath }),
    ).rejects.toThrow("source_map_too_large");
  });

  it("rejects a sparse mapping above 32 MiB", async () => {
    const f = await fixture();
    await truncate(f.mappingPath, 32 * 1024 * 1024 + 1);
    await expect(
      collectR8Build({ mappingId: "ci-123", mappingPath: f.mappingPath }),
    ).rejects.toThrow("source_map_too_large");
  });
});

describe("uploadCollectedBuild with R8 inputs", () => {
  it("uploads the SHA-verified mapping through the existing transport and keeps it", async () => {
    const f = await fixture();
    const local = await collectR8Build({
      mappingId: "ci-123",
      mappingPath: f.mappingPath,
    });
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
      requests.push({ url: String(input), init });
      if (requests.length === 1)
        return Response.json(status("uploading", false), { status: 201 });
      if (requests.length === 2) return new Response(null, { status: 204 });
      return Response.json(status("ready", true));
    };

    await expect(
      uploadCollectedBuild(
        local,
        {
          appId,
          root: f.root,
          apiUrl: "https://api.example.test/api/v1",
          token,
          deleteAfterUpload: false,
        },
        { fetch: fetcher },
      ),
    ).resolves.toEqual(status("ready", true));

    expect(requests.map(({ init }) => init.method)).toEqual([
      "POST",
      "PUT",
      "POST",
    ]);
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual(local.manifest);
    expect(Buffer.from(requests[1]!.init.body as Uint8Array)).toEqual(f.mapping);
    expect(requests.every(({ init }) => init.redirect === "error")).toBe(true);
    expect(
      requests.every(
        ({ init }) =>
          (init.headers as Record<string, string>).authorization ===
          `Bearer ${token}`,
      ),
    ).toBe(true);
    expect(await readFile(f.mappingPath)).toEqual(f.mapping);
  });

  it("rejects a mapping changed after reservation, including a ready resume", async () => {
    for (const ready of [false, true]) {
      const f = await fixture();
      const local = await collectR8Build({
        mappingId: "ci-123",
        mappingPath: f.mappingPath,
      });
      let requests = 0;
      const fetcher: typeof fetch = async () => {
        requests += 1;
        await writeFile(f.mappingPath, "changed mapping");
        return Response.json(status(ready ? "ready" : "uploading", ready));
      };
      await expect(
        uploadCollectedBuild(
          local,
          {
            appId,
            root: f.root,
            apiUrl: "https://api.example.test/api/v1",
            token,
            deleteAfterUpload: false,
          },
          { fetch: fetcher },
        ),
      ).rejects.toThrow("source_map_changed");
      expect(requests).toBe(1);
      expect(await readFile(f.mappingPath, "utf8")).toBe("changed mapping");
    }
  });

  it("rejects mismatched mapping byte evidence on a ready resume", async () => {
    const f = await fixture();
    const local = await collectR8Build({
      mappingId: "ci-123",
      mappingPath: f.mappingPath,
    });
    local.manifest.artifacts[0]!.mapBytes += 1;
    const fetcher: typeof fetch = async () =>
      Response.json(status("ready", true));

    await expect(
      uploadCollectedBuild(
        local,
        {
          appId,
          root: f.root,
          apiUrl: "https://api.example.test/api/v1",
          token,
          deleteAfterUpload: false,
        },
        { fetch: fetcher },
      ),
    ).rejects.toThrow("source_map_changed");
  });

  it("surfaces immutable mapping identity conflicts and preserves local bytes", async () => {
    const f = await fixture();
    const local = await collectR8Build({
      mappingId: "ci-123",
      mappingPath: f.mappingPath,
    });
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return Response.json(
        { error: "build_conflict", retryable: false },
        { status: 409 },
      );
    };
    await expect(
      uploadCollectedBuild(
        local,
        {
          appId,
          root: f.root,
          apiUrl: "https://api.example.test/api/v1",
          token,
          deleteAfterUpload: false,
        },
        { fetch: fetcher },
      ),
    ).rejects.toThrow("request_failed:build_conflict");
    expect(requests).toBe(1);
    expect(await readFile(f.mappingPath)).toEqual(f.mapping);
  });

  it("retries reservation and resumes artifact and completion conflicts", async () => {
    const f = await fixture();
    const local = await collectR8Build({
      mappingId: "ci-123",
      mappingPath: f.mappingPath,
    });
    const methods: string[] = [];
    const waits: number[] = [];
    let reservationAttempts = 0;
    let gets = 0;
    const fetcher: typeof fetch = async (_input, init = {}) => {
      methods.push(String(init.method));
      if (init.method === "POST" && methods.length <= 2) {
        reservationAttempts += 1;
        if (reservationAttempts === 1)
          return Response.json(
            { error: "busy", retryable: true },
            { status: 503 },
          );
        return Response.json(status("uploading", false));
      }
      if (init.method === "PUT")
        return Response.json({ error: "artifact_conflict" }, { status: 409 });
      if (init.method === "GET") {
        gets += 1;
        return Response.json(
          gets === 1 ? status("uploading", true) : status("ready", true),
        );
      }
      return Response.json({ error: "build_incomplete" }, { status: 409 });
    };
    const dependencies: UploadDependencies = {
      fetch: fetcher,
      wait: async (milliseconds) => void waits.push(milliseconds),
    };

    await expect(
      uploadCollectedBuild(
        local,
        {
          appId,
          root: f.root,
          apiUrl: "https://api.example.test/api/v1",
          token,
          deleteAfterUpload: false,
        },
        dependencies,
      ),
    ).resolves.toEqual(status("ready", true));
    expect(methods).toEqual(["POST", "POST", "PUT", "GET", "POST", "GET"]);
    expect(waits).toEqual([250]);
    expect(await readFile(f.mappingPath)).toEqual(f.mapping);
  });

  it("refuses cleanup, unsafe API URLs, and credential redirects", async () => {
    const f = await fixture();
    const local = await collectR8Build({
      mappingId: "ci-123",
      mappingPath: f.mappingPath,
    });
    const base = {
      appId,
      root: f.root,
      apiUrl: "https://api.example.test/api/v1",
      token,
      deleteAfterUpload: false,
    };
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      uploadCollectedBuild(local, { ...base, deleteAfterUpload: true }, { fetch: fetcher }),
    ).rejects.toThrow("delete_after_upload_unsupported");
    await expect(
      uploadCollectedBuild(
        local,
        { ...base, apiUrl: "http://example.test/api/v1" },
        { fetch: fetcher },
      ),
    ).rejects.toThrow("invalid_api_url");
    expect(fetcher).not.toHaveBeenCalled();

    const redirected: typeof fetch = async (_input, init = {}) => {
      expect(init.redirect).toBe("error");
      expect((init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${token}`,
      );
      throw new TypeError("redirect blocked");
    };
    let message = "";
    try {
      await uploadCollectedBuild(local, base, {
        fetch: redirected,
        wait: async () => undefined,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("request_failed:network");
    expect(message).not.toContain(token);
    expect(await readFile(f.mappingPath)).toEqual(f.mapping);
  });
});

describe("r8 upload command", () => {
  it("uses the exact command options and existing environment credentials", async () => {
    const f = await fixture();
    let reserved: unknown;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init = {}) => {
        reserved = JSON.parse(String(init.body));
        expect((init.headers as Record<string, string>).authorization).toBe(
          `Bearer ${token}`,
        );
        return Response.json(status("ready", true));
      },
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(
        main(
          [
            "r8",
            "upload",
            "--app-id",
            appId,
            "--mapping-id",
            "ci-123",
            "--mapping",
            f.mappingPath,
          ],
          {
            EVERFRAME_API_TOKEN: token,
            EVERFRAME_API_URL: "https://api.example.test/api/v1",
          },
        ),
      ).resolves.toBe(0);
      expect(reserved).toMatchObject({
        version: 3,
        runtime: "r8",
        platform: "android",
        buildId: "ci-123",
      });
      expect(log).toHaveBeenCalledWith(`R8 mapping ${buildUuid} is ready.`);
      expect(error).not.toHaveBeenCalled();
      expect(await readFile(f.mappingPath)).toEqual(f.mapping);
    } finally {
      fetcher.mockRestore();
      log.mockRestore();
      error.mockRestore();
    }
  });

  it.each(["--delete-after-upload", "--build", "--platform"])(
    "rejects unsupported option %s",
    async (unsupported) => {
      const f = await fixture();
      const fetcher = vi.spyOn(globalThis, "fetch");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const code = await main(
          [
            "r8",
            "upload",
            "--app-id",
            appId,
            "--mapping-id",
            "ci-123",
            "--mapping",
            f.mappingPath,
            unsupported,
            unsupported === "--delete-after-upload" ? "" : "unexpected",
          ].filter(Boolean),
          { EVERFRAME_API_TOKEN: token },
        );
        expect(code).toBe(1);
        expect(fetcher).not.toHaveBeenCalled();
      } finally {
        fetcher.mockRestore();
        error.mockRestore();
      }
    },
  );

  it("shows R8 command help without requiring credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(main(["r8", "upload", "--help"], {})).resolves.toBe(0);
      expect(String(log.mock.calls[0]?.[0])).toContain(
        "everframe r8 upload --app-id <uuid> --mapping-id <id> --mapping <path>",
      );
    } finally {
      log.mockRestore();
    }
  });
});
