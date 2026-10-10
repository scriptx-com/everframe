// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rename,
  symlink,
  lstat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
  uploadCollectedBuild,
  uploadBuild,
  type UploadDependencies,
  type UploadOptions,
} from "../src/upload.js";

const appId = "00000000-0000-4000-8000-000000000001";
const buildUuid = "00000000-0000-4000-8000-000000000002";
const artifactUuid = "00000000-0000-4000-8000-000000000003";
const servers: Array<ReturnType<typeof createServer>> = [];

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test_server_address");
  return `http://127.0.0.1:${address.port}/api/v1`;
}

async function fixture(
  deleteAfterUpload = false,
): Promise<UploadOptions & { mapPath: string; jsPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "everframe-upload-"));
  await mkdir(join(root, "chunks"));
  const jsPath = join(root, "chunks", "cart.js");
  const mapPath = `${jsPath}.map`;
  await writeFile(jsPath, "cart();\n");
  await writeFile(
    mapPath,
    '{"version":3,"sources":[],"names":[],"mappings":""}\n',
  );
  return {
    appId,
    buildId: "web-abc123",
    root,
    urlPrefix: "https://cdn.example/_next/static/",
    apiUrl: "",
    token: "evf_api_private-secret",
    deleteAfterUpload,
    mapPath,
    jsPath,
  };
}

function status(state: "uploading" | "ready", available: boolean) {
  return {
    buildUuid,
    status: state,
    artifacts: [
      {
        artifactUuid,
        url: "https://cdn.example/_next/static/chunks/cart.js",
        available,
      },
    ],
  };
}

function json(
  res: ServerResponse,
  code: number,
  body: unknown,
  headers?: Record<string, string>,
) {
  res.writeHead(code, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // A server that never answers keeps its sockets open.
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

describe("uploadBuild", () => {
  it("requires V1 generated-file evidence from collected local builds", async () => {
    const options = await fixture();
    options.apiUrl = await listen((_req, res) =>
      json(res, 200, status("ready", true)),
    );
    const { collectBuild } = await import("../src/manifest.js");
    const local = await collectBuild(options);
    delete local.generatedPaths;
    await expect(uploadCollectedBuild(local, options)).rejects.toThrow(
      "invalid_local_build",
    );
  });

  it("detects V1 generated-byte changes when an exact reservation resumes ready", async () => {
    const options = await fixture();
    options.apiUrl = await listen((_req, res) => {
      void writeFile(options.jsPath, "changed();\n").then(() =>
        json(res, 200, status("ready", true)),
      );
    });
    await expect(uploadBuild(options)).rejects.toThrow(
      "generated_file_changed",
    );
  });

  it("accepts a complete multi-artifact status larger than 4 KiB over HTTP", async () => {
    const options = await fixture();
    const ready = status("ready", true);
    for (let i = 0; i < 40; i++) {
      await writeFile(join(options.root, "chunks", `part-${i}.js`), "part();");
      await writeFile(
        join(options.root, "chunks", `part-${i}.js.map`),
        await readFile(options.mapPath),
      );
      ready.artifacts.push({
        artifactUuid: `artifact-${i}`,
        url: `${options.urlPrefix}chunks/part-${i}.js`,
        available: true,
      });
    }
    expect(Buffer.byteLength(JSON.stringify(ready))).toBeGreaterThan(4096);
    options.apiUrl = await listen((_req, res) => json(res, 200, ready));
    await expect(uploadBuild(options)).resolves.toEqual(ready);
  });

  it("rejects an oversized chunked success response instead of reading it without a bound", async () => {
    const options = await fixture(true);
    options.apiUrl = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(JSON.stringify(status("ready", true)));
      res.end(" ".repeat(2 * 1024 * 1024));
    });
    await expect(uploadBuild(options)).rejects.toThrow(
      "invalid_server_response",
    );
    await expect(readFile(options.mapPath)).resolves.toBeDefined();
  });

  it("resumes by server URL, uploads sequentially, completes, and deletes only the matching map", async () => {
    const options = await fixture(true);
    const methods: string[] = [];
    const originalJs = await readFile(options.jsPath);
    options.apiUrl = await listen((req, res) => {
      methods.push(req.method ?? "");
      expect(req.headers.authorization).toBe(`Bearer ${options.token}`);
      if (req.method === "POST" && req.url?.endsWith("/source-map-builds")) {
        json(res, 200, status("uploading", false));
      } else if (req.method === "PUT") {
        expect(req.headers["content-type"]).toBe("application/octet-stream");
        req.resume();
        req.on("end", () => res.writeHead(204).end());
      } else if (req.method === "POST" && req.url?.endsWith("/complete")) {
        json(res, 200, status("ready", true));
      } else {
        json(res, 404, { error: "not_found" });
      }
    });

    await expect(uploadBuild(options)).resolves.toMatchObject({
      status: "ready",
    });
    expect(methods).toEqual(["POST", "PUT", "POST"]);
    await expect(readFile(options.mapPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(options.jsPath)).toEqual(originalJs);
  });

  it("does not reupload or complete an already-ready build", async () => {
    const options = await fixture();
    let requests = 0;
    options.apiUrl = await listen((_req, res) => {
      requests += 1;
      json(res, 200, status("ready", true));
    });
    await expect(uploadBuild(options)).resolves.toMatchObject({
      status: "ready",
    });
    expect(requests).toBe(1);
  });

  it("refuses credential redirects and never reaches their destination", async () => {
    const options = await fixture();
    let destinationRequests = 0;
    const destination = await listen((_req, res) => {
      destinationRequests += 1;
      json(res, 200, status("ready", true));
    });
    options.apiUrl = await listen((_req, res) => {
      res.writeHead(307, { location: destination });
      res.end();
    });
    await expect(uploadBuild(options)).rejects.toThrow("request_failed");
    expect(destinationRequests).toBe(0);
  });

  it("honors Retry-After through an injectable bounded wait", async () => {
    const options = await fixture();
    let requests = 0;
    const waits: number[] = [];
    options.apiUrl = await listen((_req, res) => {
      requests += 1;
      if (requests === 1)
        json(res, 429, { error: "rate_limited" }, { "retry-after": "2" });
      else json(res, 200, status("ready", true));
    });
    const deps: UploadDependencies = {
      wait: async (milliseconds) => void waits.push(milliseconds),
    };
    await uploadBuild(options, deps);
    expect(waits).toEqual([2000]);
  });

  it("caps retryable HTTP and network failures at three attempts per request", async () => {
    const options = await fixture();
    let requests = 0;
    options.apiUrl = await listen((_req, res) => {
      requests += 1;
      json(res, 503, { error: "internal_error", retryable: true });
    });
    await expect(
      uploadBuild(options, { wait: async () => undefined }),
    ).rejects.toThrow("request_failed");
    expect(requests).toBe(3);

    let fetches = 0;
    const networkDeps: UploadDependencies = {
      wait: async () => undefined,
      fetch: async () => {
        fetches += 1;
        throw new TypeError("socket secret must not escape");
      },
    };
    await expect(uploadBuild(options, networkDeps)).rejects.toThrow(
      "request_failed",
    );
    expect(fetches).toBe(3);
  });

  it("retries an artifact upload with the same complete map bytes", async () => {
    const options = await fixture();
    const received: string[] = [];
    options.apiUrl = await listen((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/source-map-builds")) {
        json(res, 201, status("uploading", false));
      } else if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          received.push(Buffer.concat(chunks).toString());
          if (received.length === 1)
            json(res, 503, { error: "busy", retryable: true });
          else res.writeHead(204).end();
        });
      } else json(res, 200, status("ready", true));
    });
    await uploadBuild(options, { wait: async () => undefined });
    expect(received).toEqual([
      '{"version":3,"sources":[],"names":[],"mappings":""}\n',
      '{"version":3,"sources":[],"names":[],"mappings":""}\n',
    ]);
  });

  it("fails non-retryable 4xx immediately without exposing the token", async () => {
    const options = await fixture();
    let requests = 0;
    options.apiUrl = await listen((_req, res) => {
      requests += 1;
      json(res, 403, { error: "insufficient_scope", retryable: false });
    });
    let message = "";
    try {
      await uploadBuild(options);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(requests).toBe(1);
    expect(message).toContain("request_failed");
    expect(message).not.toContain(options.token);
  });

  it("keeps every map when completion fails", async () => {
    const options = await fixture(true);
    options.apiUrl = await listen((req, res) => {
      if (req.method === "POST" && req.url?.endsWith("/source-map-builds"))
        json(res, 201, status("uploading", false));
      else if (req.method === "PUT") {
        req.resume();
        req.on("end", () => res.writeHead(204).end());
      } else json(res, 409, { error: "build_incomplete", retryable: false });
    });
    await expect(uploadBuild(options)).rejects.toThrow("build_incomplete");
    await expect(readFile(options.mapPath)).resolves.toBeInstanceOf(Buffer);
  });

  it("resumes when an artifact upload conflict is already available", async () => {
    const options = await fixture();
    const methods: string[] = [];
    options.apiUrl = await listen((req, res) => {
      methods.push(req.method ?? "");
      if (req.method === "POST" && req.url?.endsWith("/source-map-builds"))
        json(res, 200, status("uploading", false));
      else if (req.method === "PUT") {
        req.resume();
        req.on("end", () => json(res, 409, { error: "artifact_conflict" }));
      } else if (req.method === "GET")
        json(res, 200, status("uploading", true));
      else if (req.method === "POST") json(res, 200, status("ready", true));
    });
    await expect(uploadBuild(options)).resolves.toMatchObject({
      status: "ready",
    });
    expect(methods).toEqual(["POST", "PUT", "GET", "POST"]);
  });

  it("accepts a completion conflict only when status confirms ready", async () => {
    const options = await fixture();
    const methods: string[] = [];
    options.apiUrl = await listen((req, res) => {
      methods.push(req.method ?? "");
      if (req.method === "POST" && req.url?.endsWith("/source-map-builds"))
        json(res, 200, status("uploading", true));
      else if (req.method === "POST")
        json(res, 409, { error: "build_incomplete" });
      else json(res, 200, status("ready", true));
    });
    await expect(uploadBuild(options)).resolves.toMatchObject({
      status: "ready",
    });
    expect(methods).toEqual(["POST", "POST", "GET"]);
  });

  it("detects map changes before upload and retains the changed file", async () => {
    const options = await fixture(true);
    options.apiUrl = await listen((_req, res) => {
      void writeFile(options.mapPath, '{"changed":true}').then(() =>
        json(res, 201, status("uploading", false)),
      );
    });
    await expect(uploadBuild(options)).rejects.toThrow("source_map_changed");
    expect(await readFile(options.mapPath, "utf8")).toBe('{"changed":true}');
  });

  it.each([
    "https://user:pass@example.test/api/v1",
    "https://example.test/api/v1#fragment",
    "http://example.test/api/v1",
  ])("rejects unsafe API URL %s before sending a request", async (apiUrl) => {
    const options = await fixture();
    options.apiUrl = apiUrl;
    await expect(uploadBuild(options)).rejects.toThrow("invalid_api_url");
  });
});

it("retries an interrupted HTTP response body then resumes without risking local maps", async () => {
  const options = await fixture();
  let requests = 0;
  const waits: number[] = [];
  options.apiUrl = await listen((_req, res) => {
    requests++;
    if (requests === 1) {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": "1000",
      });
      res.write('{"buildUuid":');
      setTimeout(() => res.destroy(), 25);
    } else json(res, 200, status("ready", true));
  });
  await expect(
    uploadBuild(options, {
      wait: async (ms) => {
        waits.push(ms);
        expect(await readFile(options.mapPath)).toBeDefined();
      },
    }),
  ).resolves.toMatchObject({ status: "ready" });
  expect(requests).toBe(2);
  expect(waits).toEqual([250]);
  expect(await readFile(options.mapPath)).toBeDefined();
});
it.each([
  [200, "{"],
  [200, " ".repeat(2 * 1024 * 1024 + 1)],
  [503, "{"],
  [503, " ".repeat(4097)],
] as const)(
  "does not retry malformed or oversized bodies with status %i",
  async (statusCode, body) => {
    const options = await fixture(true);
    let requests = 0;
    options.apiUrl = await listen((_req, res) => {
      requests++;
      res.writeHead(statusCode);
      res.end(body);
    });
    await expect(
      uploadBuild(options, { wait: async () => undefined }),
    ).rejects.toThrow("invalid_server_response");
    expect(requests).toBe(1);
    expect(await readFile(options.mapPath)).toBeDefined();
  },
);
it("bounds repeated HTTP body transport failures at three attempts and preserves maps", async () => {
  const options = await fixture(true);
  let requests = 0;
  options.apiUrl = await listen((_req, res) => {
    requests++;
    res.writeHead(200, { "content-length": "1000" });
    res.write("{");
    setTimeout(() => res.destroy(), 25);
  });
  await expect(
    uploadBuild(options, { wait: async () => undefined }),
  ).rejects.toThrow("request_failed:network");
  expect(requests).toBe(3);
  expect(await readFile(options.mapPath)).toBeDefined();
});

it.each(["file", "parent"] as const)(
  "rejects %s map symlinks before requests when cleanup is enabled",
  async (kind) => {
    const options = await fixture(true);
    const bytes = await readFile(options.mapPath);
    const target = join(
      options.root,
      kind === "file" ? "private-map.bin" : "real-chunks",
    );
    if (kind === "file") {
      await rename(options.mapPath, target);
      await symlink(target, options.mapPath);
    } else {
      await rename(join(options.root, "chunks"), target);
      await symlink(target, join(options.root, "chunks"));
    }
    const unrelated = join(options.root, "unrelated.map");
    await writeFile(unrelated, "keep");
    let requests = 0;
    options.apiUrl = await listen((_req, res) => {
      requests++;
      json(res, 200, status("ready", true));
    });
    await expect(uploadBuild(options)).rejects.toThrow(
      "symlink_cleanup_unsupported",
    );
    expect(requests).toBe(0);
    expect(await readFile(options.mapPath)).toEqual(bytes);
    expect(await readFile(unrelated, "utf8")).toBe("keep");
    expect(
      (
        await lstat(
          kind === "file" ? options.mapPath : join(options.root, "chunks"),
        )
      ).isSymbolicLink(),
    ).toBe(true);
  },
);
it("preserves supported in-root map symlink uploads without cleanup", async () => {
  const options = await fixture();
  const target = join(options.root, "private-map.bin");
  await rename(options.mapPath, target);
  await symlink(target, options.mapPath);
  options.apiUrl = await listen((_req, res) =>
    json(res, 200, status("ready", true)),
  );
  await expect(uploadBuild(options)).resolves.toMatchObject({
    status: "ready",
  });
  expect((await lstat(options.mapPath)).isSymbolicLink()).toBe(true);
});

describe("upload time limits", () => {
  it("times out a request whose server accepts the connection and never answers", async () => {
    const options = await fixture();
    options.apiUrl = await listen(() => undefined);
    const started = Date.now();
    await expect(
      uploadBuild(options, { wait: async () => undefined, requestTimeoutMs: 50 }),
    ).rejects.toThrow("request_failed:timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops at the overall time budget even inside a request", async () => {
    const options = await fixture();
    options.apiUrl = await listen(() => undefined);
    const started = Date.now();
    await expect(
      uploadBuild(options, { wait: async () => undefined, deadline: Date.now() + 200 }),
    ).rejects.toThrow("upload_time_budget_exhausted");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("waits out upload_busy as told while the budget lasts, then carries on", async () => {
    const options = await fixture();
    let requests = 0;
    const waits: number[] = [];
    options.apiUrl = await listen((_req, res) => {
      requests += 1;
      if (requests <= 5)
        json(res, 429, { error: "upload_busy", retryable: true }, { "retry-after": "30" });
      else json(res, 200, status("ready", true));
    });
    await uploadBuild(options, {
      wait: async (milliseconds) => void waits.push(milliseconds),
      deadline: Date.now() + 10 * 60_000,
    });
    expect(waits).toEqual(Array(5).fill(30_000));
  });

  it("gives up on upload_busy when waiting would pass the budget", async () => {
    const options = await fixture();
    const waits: number[] = [];
    options.apiUrl = await listen((_req, res) =>
      json(res, 429, { error: "upload_busy", retryable: true }, { "retry-after": "30" }),
    );
    await expect(
      uploadBuild(options, {
        wait: async (milliseconds) => void waits.push(milliseconds),
        deadline: Date.now() + 5_000,
      }),
    ).rejects.toThrow("upload_time_budget_exhausted");
    expect(waits).toEqual([]);
  });
});
