// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, truncate, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { collectDsymBuild } from "../src/dsym.js";
import { uploadCollectedBuild } from "../src/upload.js";
import { verifyDsymFile } from "../src/upload-snapshot.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-large-upload-test-"));
  roots.push(root);
  const path = join(root, "App");
  await writeFile(path, "original DWARF content");
  return { root, path };
}
const status = (ready = false) => ({
  buildUuid: "build",
  status: ready ? "ready" : "uploading",
  artifacts: [
    { artifactUuid: "artifact", url: "dsym://apple/dwarf", available: ready },
  ],
});
const options = (root: string) => ({
  root,
  appId: "app",
  apiUrl: "http://127.0.0.1/api/v1",
  token: "test-token",
  deleteAfterUpload: false,
});
it("streams a >64MiB dSYM to a real HTTP receiver with exact hash and length", async () => {
  const f = await fixture();
  await truncate(f.path, 65 * 1024 * 1024);
  const local = await collectDsymBuild({ dwarfPath: f.path });
  const received: { bytes: number; sha: string; length: string | undefined }[] =
    [];
  const server = createServer(async (req, res) => {
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of req) {
      bytes += chunk.length;
      hash.update(chunk);
    }
    if (req.method === "PUT") {
      received.push({
        bytes,
        sha: hash.digest("hex"),
        length: req.headers["content-length"],
      });
      res.writeHead(204).end();
    } else
      res
        .setHeader("content-type", "application/json")
        .end(JSON.stringify(status(req.url?.endsWith("/complete"))));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const result = await uploadCollectedBuild(local, {
      ...options(f.root),
      apiUrl: `http://127.0.0.1:${port}`,
    });
    expect(result.status).toBe("ready");
    expect(received).toEqual([
      {
        bytes: 68157440,
        sha: local.manifest.artifacts[0]!.mapSha256,
        length: "68157440",
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 15000);
it("retries the immutable snapshot and detects changed source after completion", async () => {
  const f = await fixture();
  const local = await collectDsymBuild({ dwarfPath: f.path });
  const sent: string[] = [];
  const streams: Readable[] = [];
  await expect(
    uploadCollectedBuild(local, options(f.root), {
      wait: async () => {},
      fetch: async (url, init) => {
        if (init?.method !== "PUT")
          return Response.json(status(String(url).endsWith("/complete")));
        expect(init.body).toBeInstanceOf(Readable);
        streams.push(init.body as unknown as Readable);
        sent.push(await new Response(init.body).text());
        if (sent.length === 1) {
          await writeFile(f.path, "modified DWARF content");
          return Response.json({}, { status: 503 });
        }
        return new Response(null, { status: 204 });
      },
    }),
  ).rejects.toThrow("source_map_changed");
  expect(sent).toEqual(["original DWARF content", "original DWARF content"]);
  expect(streams[0]).not.toBe(streams[1]);
  for (const stream of streams) {
    expect(stream.closed).toBe(true);
    await expect(
      access(String((stream as Readable & { path: string }).path)),
    ).rejects.toThrow();
  }
});
it("closes and removes a snapshot when the receiver rejects before reading", async () => {
  const f = await fixture();
  const local = await collectDsymBuild({ dwarfPath: f.path });
  let body: Readable | undefined;
  await expect(
    uploadCollectedBuild(local, options(f.root), {
      fetch: async (_url, init) => {
        if (init?.method !== "PUT") return Response.json(status());
        expect(init.body).toBeInstanceOf(Readable);
        body = init.body as unknown as Readable;
        return Response.json({ error: "upload_rejected" }, { status: 400 });
      },
    }),
  ).rejects.toThrow("request_failed:upload_rejected");
  expect(body?.closed).toBe(true);
  await expect(
    access(String((body as Readable & { path: string }).path)),
  ).rejects.toThrow();
});
it("refuses a declared size over 512 MiB even when the bytes match", async () => {
  const f = await fixture();
  await writeFile(f.path, "");
  await truncate(f.path, 512 * 1024 * 1024 + 1);
  const hash = createHash("sha256");
  const zeros = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < 512; i++) hash.update(zeros);
  await expect(
    verifyDsymFile(f.path, {
      mapBytes: 512 * 1024 * 1024 + 1,
      mapSha256: hash.update(Buffer.alloc(1)).digest("hex"),
    }),
  ).rejects.toThrow("source_map_changed");
}, 30000);
it("reports a receiver's 401 for a streamed dSYM after one PUT", async () => {
  const f = await fixture();
  const local = await collectDsymBuild({ dwarfPath: f.path });
  let puts = 0;
  const server = createServer((req, res) => {
    if (req.method === "PUT") {
      puts += 1;
      res
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error: "invalid_api_token" }));
      return;
    }
    req.resume();
    req.on("end", () =>
      res
        .setHeader("content-type", "application/json")
        .end(JSON.stringify(status())),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const credentials: unknown[] = [];
    await expect(
      uploadCollectedBuild(
        local,
        { ...options(f.root), apiUrl: `http://127.0.0.1:${port}` },
        {
          wait: async () => {},
          // Fetch before undici 7.19 has no 401 step, so pin the option too.
          fetch: (input, init) => {
            if (init?.method === "PUT") credentials.push(init.credentials);
            return fetch(input, init);
          },
        },
      ),
    ).rejects.toThrow("request_failed:invalid_api_token");
    expect(puts).toBe(1);
    expect(credentials).toEqual(["omit"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it("reports a snapshot that cannot be opened as a failed request", async () => {
  const f = await fixture();
  const local = await collectDsymBuild({ dwarfPath: f.path });
  const uncaught: unknown[] = [];
  const record = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", record);
  try {
    await expect(
      uploadCollectedBuild(local, options(f.root), {
        wait: async () => {},
        fetch: async (_url, init) => {
          if (init?.method !== "PUT") return Response.json(status());
          const path = String((init.body as unknown as { path: string }).path);
          rmSync(dirname(path), { recursive: true, force: true });
          // Fetch reads the body only after connecting; the open fails first.
          await new Promise((resolve) => setTimeout(resolve, 50));
          await new Response(init.body).arrayBuffer();
          return new Response(null, { status: 204 });
        },
      }),
    ).rejects.toThrow("request_failed:network");
    expect(uncaught).toEqual([]);
  } finally {
    process.off("uncaughtException", record);
  }
});
