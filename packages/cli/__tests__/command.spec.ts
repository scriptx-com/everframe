// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectStagedBuild } from "../src/build-collect.js";
import { main } from "../src/index.js";

describe("main", () => {
  it("rejects the delete flag for Hermes uploads", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const exit = await main(
        ["sourcemaps", "upload-hermes", "--delete-after-upload"],
        { EVERFRAME_API_TOKEN: "secret" },
      );
      expect(exit).toBe(1);
      expect(error).toHaveBeenCalledWith("delete_after_upload_unsupported");
    } finally {
      error.mockRestore();
    }
  });

  it("requires the token only from EVERFRAME_API_TOKEN and never prints it", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const token = "evf_api_do-not-print";
    const exit = await main(
      [
        "sourcemaps",
        "upload",
        "--app-id",
        "00000000-0000-4000-8000-000000000001",
        "--build",
        "b",
        "--dir",
        ".",
        "--url-prefix",
        "https://cdn.example/",
        "--token",
        token,
      ],
      { EVERFRAME_API_TOKEN: token },
    );
    expect(exit).toBe(1);
    expect(
      `${error.mock.calls.flat().join(" ")}${log.mock.calls.flat().join(" ")}`,
    ).not.toContain(token);
    error.mockRestore();
    log.mockRestore();
  });

  it("shows help from the built executable", async () => {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, "..", "dist", "index.js"), "--help"],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const [code] = (await once(child, "close")) as [number];
    expect(code).toBe(0);
    expect(stdout).toContain("everframe sourcemaps upload");
    expect(stdout).toContain("everframe sourcemaps upload-hermes");
    expect(stdout).toContain("everframe r8 upload");
    expect(stdout).toContain("--bundle-name");
    expect(stdout).toContain("--source-map");
    expect(stderr).toBe("");
  });
});
it("collects one snapshot and still rejects map changes after reporting uncovered files", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const manifestModule = await import("../src/manifest.js");
  const collect = vi.spyOn(manifestModule, "collectBuild");
  const root = await mkdtemp(join(tmpdir(), "everframe-command-"));
  await writeFile(join(root, "a.js"), "a();");
  await writeFile(join(root, "a.js.map"), "{}");
  await writeFile(join(root, "uncovered.js"), "u();");
  const { writeFileSync } = await import("node:fs");
  const log = vi.spyOn(console, "log").mockImplementation((line) => {
    if (String(line).startsWith("Uncovered"))
      writeFileSync(join(root, "a.js.map"), '{"changed":true}');
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({
        buildUuid: "build",
        status: "uploading",
        artifacts: [
          {
            artifactUuid: "artifact",
            url: "https://cdn.example/a.js",
            available: false,
          },
        ],
      }),
    );
  try {
    const code = await main(
      [
        "sourcemaps",
        "upload",
        "--app-id",
        "app",
        "--build",
        "b",
        "--dir",
        root,
        "--url-prefix",
        "https://cdn.example/",
      ],
      { EVERFRAME_API_TOKEN: "secret" },
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("source_map_changed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    collect.mockRestore();
    log.mockRestore();
    error.mockRestore();
    fetcher.mockRestore();
  }
});

it("uploads by path when --url-prefix is omitted", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const manifestModule = await import("../src/manifest.js");
  const collect = vi.spyOn(manifestModule, "collectBuild");
  const root = await mkdtemp(join(tmpdir(), "everframe-command-"));
  await writeFile(join(root, "a.js"), "a();");
  await writeFile(join(root, "a.js.map"), "{}");
  await writeFile(join(root, "uncovered.js"), "u();");
  const { writeFileSync } = await import("node:fs");
  const log = vi.spyOn(console, "log").mockImplementation((line) => {
    if (String(line).startsWith("Uncovered"))
      writeFileSync(join(root, "a.js.map"), '{"changed":true}');
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({
        buildUuid: "build",
        status: "uploading",
        artifacts: [
          {
            artifactUuid: "artifact",
            url: "~/a.js",
            available: false,
          },
        ],
      }),
    );
  try {
    const code = await main(
      [
        "sourcemaps",
        "upload",
        "--app-id",
        "app",
        "--build",
        "b",
        "--dir",
        root,
      ],
      { EVERFRAME_API_TOKEN: "secret" },
    );
    expect(collect).toHaveBeenCalledTimes(1);
    expect(code).toBe(1);
    expect(error).toHaveBeenCalledWith("source_map_changed");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body.artifacts[0].url).toMatch(/^~\//);
  } finally {
    collect.mockRestore();
    log.mockRestore();
    error.mockRestore();
    fetcher.mockRestore();
  }
});

describe("build commands", () => {
  it("rejects an unknown build subcommand", async () => {
    expect(await main(["build", "frobnicate"], {})).toBe(1);
  });

  it("requires a platform for collect", async () => {
    expect(await main(["build", "collect", "--staging", "/tmp/x"], {})).toBe(1);
  });

  it("exits 1 when verify fails a release build", async () => {
    const staging = await mkdtemp(join(tmpdir(), "everframe-cmd-"));
    expect(
      await main(
        ["build", "verify", "--staging", staging, "--platform", "android", "--release"],
        { EVERFRAME_API_TOKEN: "token" },
      ),
    ).toBe(1);
  });

  it("exits 0 when verify only warns", async () => {
    const staging = await mkdtemp(join(tmpdir(), "everframe-cmd-"));
    expect(
      await main(["build", "verify", "--staging", staging, "--platform", "android"], {
        EVERFRAME_API_TOKEN: "token",
      }),
    ).toBe(0);
  });

  it("rejects upload-hermes when --manifest is combined with --bundle", async () => {
    expect(
      await main(
        [
          "sourcemaps",
          "upload-hermes",
          "--manifest",
          "/tmp/x",
          "--bundle",
          "/tmp/b",
          "--platform",
          "android",
          "--app-id",
          "00000000-0000-4000-8000-000000000000",
        ],
        { EVERFRAME_API_TOKEN: "token" },
      ),
    ).toBe(1);
  });

  // `build collect` records the hashes of the exact bytes hermesc produced.
  // If anything rewrites the bundle or the map before upload, the pair being
  // published no longer matches the pair that was verified.
  describe("upload-hermes --manifest re-checks the staged hashes", () => {
    const HERMES_MAGIC = Buffer.from([
      0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f,
    ]);
    const buildId = "8f3ac21e-0000-4000-8000-000000000001";

    async function stage(): Promise<{
      staging: string;
      bundlePath: string;
      mapPath: string;
    }> {
      const root = await mkdtemp(join(tmpdir(), "everframe-rehash-"));
      const staging = join(root, ".everframe");
      await mkdir(join(staging, buildId), { recursive: true });
      await writeFile(
        join(staging, "latest-android.json"),
        JSON.stringify({ buildId }),
      );
      await writeFile(
        join(staging, buildId, "manifest.partial.json"),
        JSON.stringify({
          schema: 1,
          buildId,
          platform: "android",
          bundleName: "index.android.bundle",
          dev: false,
        }),
      );
      const bundlePath = join(root, "index.android.bundle");
      const mapPath = join(root, "index.android.bundle.map");
      await writeFile(
        bundlePath,
        Buffer.concat([HERMES_MAGIC, Buffer.from(buildId), Buffer.alloc(64, 1)]),
      );
      await writeFile(
        mapPath,
        JSON.stringify({ version: 3, sources: [`/.everframe/${buildId}/identity.js`], mappings: "" }),
      );
      await collectStagedBuild({
        stagingDir: staging,
        platform: "android",
        bundlePath,
        mapPath,
      });
      return { staging, bundlePath, mapPath };
    }

    const upload = (staging: string): Promise<number> =>
      main(
        [
          "sourcemaps",
          "upload-hermes",
          "--manifest",
          staging,
          "--platform",
          "android",
          "--app-id",
          "00000000-0000-4000-8000-000000000000",
        ],
        { EVERFRAME_API_TOKEN: "token" },
      );

    it("refuses a bundle rewritten after collect", async () => {
      const { staging, bundlePath } = await stage();
      await writeFile(
        bundlePath,
        Buffer.concat([HERMES_MAGIC, Buffer.alloc(64, 2)]),
      );
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        expect(await upload(staging)).toBe(1);
        expect(error.mock.calls[0]?.[0]).toContain("staged_bundle_changed");
      } finally {
        error.mockRestore();
      }
    });

    it("refuses a source map rewritten after collect", async () => {
      const { staging, mapPath } = await stage();
      await writeFile(
        mapPath,
        JSON.stringify({ version: 3, sources: ["a.js"], mappings: "AAAA" }),
      );
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        expect(await upload(staging)).toBe(1);
        expect(error.mock.calls[0]?.[0]).toContain("staged_source_map_changed");
      } finally {
        error.mockRestore();
      }
    });
  });

  it("prints the new commands in help", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (value: string) => {
      lines.push(value);
    };
    try {
      await main(["--help"], {});
    } finally {
      console.log = log;
    }
    expect(lines.join("\n")).toContain("build collect");
    expect(lines.join("\n")).toContain("build verify");
  });
});
