// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdtemp,
  link,
  mkdir,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHermesBuild } from "../src/hermes.js";
import { main } from "../src/index.js";
import { uploadCollectedBuild } from "../src/upload.js";

const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const appId = "00000000-0000-4000-8000-000000000001";
const buildUuid = "00000000-0000-4000-8000-000000000002";
const artifactUuid = "00000000-0000-4000-8000-000000000003";
const servers: Array<ReturnType<typeof createServer>> = [];

const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test_server_address");
  return "http://127.0.0.1:" + address.port + "/api/v1";
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-hermes-"));
  const bundleDir = join(root, "android", "assets");
  const mapDir = join(root, "maps", "release");
  await mkdir(bundleDir, { recursive: true });
  await mkdir(mapDir, { recursive: true });
  const bundlePath = join(bundleDir, "index.android.bundle");
  const sourceMapPath = join(mapDir, "index.android.bundle.map");
  const bundle = Buffer.concat([HBC_MAGIC, Buffer.from([0, 1, 2, 3, 255])]);
  const sourceMap = Buffer.from([0, 255, 1, 128, 17]);
  await writeFile(bundlePath, bundle);
  await writeFile(sourceMapPath, sourceMap);
  return { root, bundlePath, sourceMapPath, bundle, sourceMap };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("collectHermesBuild", () => {
  it("collects separate bytecode and map directories with exact streaming hashes", async () => {
    const f = await fixture();
    const local = await collectHermesBuild({
      buildId: "run-7-android",
      platform: "android",
      bundleName: "index.android.bundle",
      bundlePath: f.bundlePath,
      sourceMapPath: f.sourceMapPath,
    });
    expect(local.manifest).toEqual({
      version: 2,
      runtime: "hermes",
      platform: "android",
      buildId: "run-7-android",
      artifacts: [
        {
          url: "hermes://android/index.android.bundle",
          generatedSha256: sha(f.bundle),
          mapSha256: sha(f.sourceMap),
          mapBytes: f.sourceMap.length,
        },
      ],
    });
    expect([...local.generatedPaths!.values()]).toEqual([f.bundlePath]);
    expect([...local.mapPaths.values()]).toEqual([f.sourceMapPath]);
    expect(local.uncovered).toEqual([]);
  });

  it("requires the real final Hermes bytecode magic", async () => {
    const f = await fixture();
    await writeFile(
      f.bundlePath,
      Buffer.concat([
        Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x00]),
        Buffer.from("not-hbc"),
      ]),
    );
    await expect(
      collectHermesBuild({
        buildId: "b",
        platform: "android",
        bundleName: "index.android.bundle",
        bundlePath: f.bundlePath,
        sourceMapPath: f.sourceMapPath,
      }),
    ).rejects.toThrow("invalid_hermes_bytecode");
  });

  it("rejects missing, identical, and escaping symlink inputs", async () => {
    const f = await fixture();
    const options = {
      buildId: "b",
      platform: "android" as const,
      bundleName: "index.android.bundle",
      bundlePath: f.bundlePath,
      sourceMapPath: join(f.root, "missing.map"),
    };
    await expect(collectHermesBuild(options)).rejects.toThrow();
    await expect(
      collectHermesBuild({
        ...options,
        sourceMapPath: f.bundlePath,
      }),
    ).rejects.toThrow("same_input_file");

    const outside = await mkdtemp(join(tmpdir(), "everframe-hermes-outside-"));
    const outsideBundle = join(outside, "index.android.bundle");
    await writeFile(outsideBundle, f.bundle);
    const link = join(f.root, "android", "assets", "linked.bundle");
    await symlink(outsideBundle, link);
    await expect(
      collectHermesBuild({
        ...options,
        bundlePath: link,
        sourceMapPath: f.sourceMapPath,
      }),
    ).rejects.toThrow("symlink_escapes_root");
  });

  it("rejects two paths that are hard links to the same input file", async () => {
    const f = await fixture();
    const alias = join(f.root, "maps", "release", "alias.map");
    await link(f.bundlePath, alias);
    await expect(
      collectHermesBuild({
        buildId: "b",
        platform: "android",
        bundleName: "index.android.bundle",
        bundlePath: f.bundlePath,
        sourceMapPath: alias,
      }),
    ).rejects.toThrow("same_input_file");
  });

  it("rejects a sparse source map above 32 MiB without parsing JSON", async () => {
    const f = await fixture();
    await truncate(f.sourceMapPath, 32 * 1024 * 1024 + 1);
    await expect(
      collectHermesBuild({
        buildId: "b",
        platform: "android",
        bundleName: "index.android.bundle",
        bundlePath: f.bundlePath,
        sourceMapPath: f.sourceMapPath,
      }),
    ).rejects.toThrow("source_map_too_large");
  });
});

describe("uploadCollectedBuild with Hermes inputs", () => {
  it("runs the upload-hermes command against local HTTP with explicit paths", async () => {
    const f = await fixture();
    let reserved: unknown;
    const apiUrl = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        reserved = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        json(res, 200, {
          buildUuid,
          status: "ready",
          artifacts: [
            {
              artifactUuid,
              url: "hermes://android/index.android.bundle",
              available: true,
            },
          ],
        });
      });
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await expect(
        main(
          [
            "sourcemaps",
            "upload-hermes",
            "--app-id",
            appId,
            "--build",
            "run-7-android",
            "--platform",
            "android",
            "--bundle-name",
            "index.android.bundle",
            "--bundle",
            f.bundlePath,
            "--source-map",
            f.sourceMapPath,
          ],
          {
            EVERFRAME_API_TOKEN: "private-token",
            EVERFRAME_API_URL: apiUrl,
          },
        ),
      ).resolves.toBe(0);
      expect(reserved).toEqual({
        version: 2,
        runtime: "hermes",
        platform: "android",
        buildId: "run-7-android",
        artifacts: [
          {
            url: "hermes://android/index.android.bundle",
            generatedSha256: sha(f.bundle),
            mapSha256: sha(f.sourceMap),
            mapBytes: f.sourceMap.length,
          },
        ],
      });
      expect(error).not.toHaveBeenCalled();
      expect(await readFile(f.bundlePath)).toEqual(f.bundle);
      expect(await readFile(f.sourceMapPath)).toEqual(f.sourceMap);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("uploads through a real local HTTP server, reaches ready, and preserves both inputs", async () => {
    const f = await fixture();
    const local = await collectHermesBuild({
      buildId: "run-7-android",
      platform: "android",
      bundleName: "index.android.bundle",
      bundlePath: f.bundlePath,
      sourceMapPath: f.sourceMapPath,
    });
    const url = local.manifest.artifacts[0].url;
    let uploaded = Buffer.alloc(0);
    const apiUrl = await listen((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/source-map-builds")) {
        json(res, 201, {
          buildUuid,
          status: "uploading",
          artifacts: [{ artifactUuid, url, available: false }],
        });
      } else if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          uploaded = Buffer.concat(chunks);
          res.writeHead(204).end();
        });
      } else {
        json(res, 200, {
          buildUuid,
          status: "ready",
          artifacts: [{ artifactUuid, url, available: true }],
        });
      }
    });
    const beforeBundle = await readFile(f.bundlePath);
    const beforeMap = await readFile(f.sourceMapPath);
    await expect(
      uploadCollectedBuild(local, {
        appId,
        apiUrl,
        token: "private-token",
        root: dirname(f.sourceMapPath),
        deleteAfterUpload: false,
      }),
    ).resolves.toMatchObject({ status: "ready" });
    expect(uploaded).toEqual(f.sourceMap);
    expect(await readFile(f.bundlePath)).toEqual(beforeBundle);
    expect(await readFile(f.sourceMapPath)).toEqual(beforeMap);
  });

  it.each(["bundle", "map"] as const)(
    "detects %s mutation even when an exact reservation resumes ready",
    async (target) => {
      const f = await fixture();
      const local = await collectHermesBuild({
        buildId: "run-7-android",
        platform: "android",
        bundleName: "index.android.bundle",
        bundlePath: f.bundlePath,
        sourceMapPath: f.sourceMapPath,
      });
      const url = local.manifest.artifacts[0].url;
      const apiUrl = await listen((_req, res) => {
        void writeFile(
          target === "bundle" ? f.bundlePath : f.sourceMapPath,
          target === "bundle"
            ? Buffer.concat([HBC_MAGIC, Buffer.from("changed")])
            : Buffer.from("changed"),
        ).then(() =>
          json(res, 200, {
            buildUuid,
            status: "ready",
            artifacts: [{ artifactUuid, url, available: true }],
          }),
        );
      });
      await expect(
        uploadCollectedBuild(local, {
          appId,
          apiUrl,
          token: "private-token",
          root: dirname(f.sourceMapPath),
          deleteAfterUpload: false,
        }),
      ).rejects.toThrow(
        target === "bundle" ? "generated_file_changed" : "source_map_changed",
      );
    },
  );

  it("surfaces a permanent reservation conflict and leaves both inputs unchanged", async () => {
    const f = await fixture();
    const local = await collectHermesBuild({
      buildId: "run-7-android",
      platform: "android",
      bundleName: "index.android.bundle",
      bundlePath: f.bundlePath,
      sourceMapPath: f.sourceMapPath,
    });
    const apiUrl = await listen((_req, res) =>
      json(res, 409, { error: "build_conflict", retryable: false }),
    );
    await expect(
      uploadCollectedBuild(local, {
        appId,
        apiUrl,
        token: "private-token",
        root: dirname(f.sourceMapPath),
        deleteAfterUpload: false,
      }),
    ).rejects.toThrow("request_failed:build_conflict");
    expect(await readFile(f.bundlePath)).toEqual(f.bundle);
    expect(await readFile(f.sourceMapPath)).toEqual(f.sourceMap);
  });
});
