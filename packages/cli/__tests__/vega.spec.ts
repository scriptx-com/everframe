// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectHermesBuild } from "../src/hermes.js";
import { main } from "../src/index.js";
import { collectVegaBuilds } from "../src/vega.js";

const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const appId = "00000000-0000-4000-8000-000000000001";
const servers: Array<ReturnType<typeof createServer>> = [];
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

/** What `react-native build-vega --build-type Release` leaves behind. */
async function vegaBuild(opts: { stale?: boolean; idInMap?: (id: string) => string | undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), "everframe-vega-"));
  const dir = join(root, "build", "lib", "rn-bundles", "Release");
  await mkdir(dir, { recursive: true });
  const bundle = "var __BUNDLE_START_TIME__=0;\nfunction onPress(){throw new Error('x')}\n";
  const bundleId = sha(bundle);
  const map = { version: 3, sources: ["src/App.tsx"], names: [], mappings: "AAAA", x_amazon_bundleId: bundleId };
  const idInMap = opts.idInMap ? opts.idInMap(bundleId) : bundleId;
  if (idInMap === undefined) delete (map as Partial<typeof map>).x_amazon_bundleId;
  else map.x_amazon_bundleId = idInMap;
  const mapText = JSON.stringify(map);
  await writeFile(join(dir, "index.bundle"), bundle);
  await writeFile(join(dir, `${bundleId}.bundle.map`), mapText);
  await writeFile(join(dir, "index.hermes.bundle"), Buffer.concat([HBC_MAGIC, Buffer.from("bytecode")]));
  const staleId = "e".repeat(64);
  if (opts.stale) {
    await writeFile(join(dir, `${staleId}.bundle.map`), JSON.stringify({ ...map, x_amazon_bundleId: staleId }));
  }
  return { root, dir, bundle, bundleId, mapText, staleId };
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test_server_address");
  return `http://127.0.0.1:${address.port}/api/v1`;
}

describe("collectVegaBuilds", () => {
  it("registers each map under its bundle id with the JavaScript bundle as the generated file", async () => {
    const f = await vegaBuild({ stale: true });
    const { builds, stale } = await collectVegaBuilds(f.dir);
    expect(stale).toEqual([f.staleId]);
    expect(builds).toHaveLength(1);
    expect(builds[0]!.bundleId).toBe(f.bundleId);
    expect(builds[0]!.local.manifest).toEqual({
      version: 2,
      runtime: "hermes",
      platform: "vega",
      buildId: f.bundleId,
      artifacts: [{
        url: `hermes://vega/${f.bundleId}.bundle`,
        generatedSha256: f.bundleId,
        mapSha256: sha(f.mapText),
        mapBytes: Buffer.byteLength(f.mapText),
      }],
    });
    expect([...builds[0]!.local.generatedPaths!.values()]).toEqual([join(await realpath(f.dir), "index.bundle")]);
  });

  it("accepts a map without the Amazon id field, keyed by its file name", async () => {
    const f = await vegaBuild({ idInMap: () => undefined });
    expect((await collectVegaBuilds(f.dir)).builds.map((b) => b.bundleId)).toEqual([f.bundleId]);
  });

  it("rejects a map whose recorded id differs from its file name", async () => {
    const f = await vegaBuild({ idInMap: () => "0".repeat(64) });
    await expect(collectVegaBuilds(f.dir)).rejects.toThrow("vega_bundle_id_mismatch");
  });

  it("explains an empty or wrong directory", async () => {
    const f = await vegaBuild();
    await expect(collectVegaBuilds(f.root)).rejects.toThrow("vega_source_map_not_found");
    await expect(collectVegaBuilds(join(f.root, "missing"))).rejects.toThrow();
  });
});

describe("collectHermesBuild for vega", () => {
  it("refuses bytecode and a bundle that does not hash to its name", async () => {
    const f = await vegaBuild();
    const base = {
      buildId: f.bundleId,
      platform: "vega" as const,
      bundleName: `${f.bundleId}.bundle`,
      sourceMapPath: join(f.dir, `${f.bundleId}.bundle.map`),
    };
    await expect(collectHermesBuild({ ...base, bundlePath: join(f.dir, "index.hermes.bundle") }))
      .rejects.toThrow("vega_bundle_is_bytecode");
    await writeFile(join(f.dir, "other.bundle"), "var changed = 1;\n");
    await expect(collectHermesBuild({ ...base, bundlePath: join(f.dir, "other.bundle") }))
      .rejects.toThrow("vega_bundle_id_mismatch");
    // A custom pipeline may use its own names; then there is nothing to cross-check.
    await expect(collectHermesBuild({ ...base, buildId: "ci-77", bundleName: "main.bundle", bundlePath: join(f.dir, "other.bundle") }))
      .resolves.toMatchObject({ manifest: { platform: "vega", buildId: "ci-77" } });
  });
});

describe("everframe sourcemaps upload-vega", () => {
  it("uploads the current build's map and skips leftovers", async () => {
    const f = await vegaBuild({ stale: true });
    const url = `hermes://vega/${f.bundleId}.bundle`;
    let reserved: unknown;
    let uploaded = Buffer.alloc(0);
    const apiUrl = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        if (req.method === "POST" && req.url?.endsWith("/source-map-builds")) {
          reserved = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          json(res, 201, { buildUuid: "build-1", status: "uploading", artifacts: [{ artifactUuid: "a-1", url, available: false }] });
        } else if (req.method === "PUT") {
          uploaded = Buffer.concat(chunks);
          res.writeHead(204).end();
        } else {
          json(res, 200, { buildUuid: "build-1", status: "ready", artifacts: [{ artifactUuid: "a-1", url, available: true }] });
        }
      });
    });
    const lines: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line) => void lines.push(String(line)));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(main(["sourcemaps", "upload-vega", "--dir", f.dir], {
        EVERFRAME_API_TOKEN: "private-token",
        EVERFRAME_API_URL: apiUrl,
        EVERFRAME_APP_ID: appId,
      })).resolves.toBe(0);
      expect(reserved).toMatchObject({ version: 2, runtime: "hermes", platform: "vega", buildId: f.bundleId });
      expect(uploaded.toString("utf8")).toBe(f.mapText);
      expect(lines).toEqual([
        `Skipped ${f.staleId}.bundle.map: no JavaScript bundle in ${f.dir} hashes to it (a map from an earlier build).`,
        `Source-map build build-1 is ready (Vega bundle ${f.bundleId}).`,
      ]);
      expect(error).not.toHaveBeenCalled();
      expect(await readFile(join(f.dir, `${f.bundleId}.bundle.map`), "utf8")).toBe(f.mapText);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it("needs an app id and a token", async () => {
    const f = await vegaBuild();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await main(["sourcemaps", "upload-vega", "--dir", f.dir], { EVERFRAME_API_TOKEN: "private-token" })).toBe(1);
      expect(await main(["sourcemaps", "upload-vega", "--dir", f.dir, "--app-id", appId], {})).toBe(1);
      expect(error).toHaveBeenCalledWith("missing_required_option");
    } finally {
      error.mockRestore();
    }
  });

  it("fails when only leftovers are found", async () => {
    const f = await vegaBuild();
    await writeFile(join(f.dir, "index.bundle"), "var rebuilt = true;\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      expect(await main(["sourcemaps", "upload-vega", "--dir", f.dir, "--app-id", appId], { EVERFRAME_API_TOKEN: "private-token" })).toBe(1);
      expect(error).toHaveBeenCalledWith("vega_bundle_not_found");
    } finally {
      error.mockRestore();
      log.mockRestore();
    }
  });
});
