// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectBuild } from "../src/manifest.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "everframe-cli-"));
  await mkdir(join(root, "chunks"));
  return root;
}

describe("collectBuild", () => {
  it("pairs files, hashes exact bytes, encodes segments, and sorts by URL", async () => {
    const root = await fixture();
    await writeFile(join(root, "chunks", "z.js"), "z();\n");
    await writeFile(join(root, "chunks", "z.js.map"), '{"z":1}\n');
    await writeFile(join(root, "chunks", "cart space%20.js"), "cart();\n");
    await writeFile(
      join(root, "chunks", "cart space%20.js.map"),
      '{"cart":1}\n',
    );
    await writeFile(join(root, "chunks", "uncovered.js"), "noMap();\n");

    const build = await collectBuild({
      buildId: "web-abc123",
      root,
      urlPrefix: "https://cdn.example/_next/static/",
    });

    expect(build.manifest).toEqual({
      version: 1,
      buildId: "web-abc123",
      artifacts: [
        {
          url: "https://cdn.example/_next/static/chunks/cart%20space%2520.js",
          generatedSha256: sha("cart();\n"),
          mapSha256: sha('{"cart":1}\n'),
          mapBytes: 11,
        },
        {
          url: "https://cdn.example/_next/static/chunks/z.js",
          generatedSha256: sha("z();\n"),
          mapSha256: sha('{"z":1}\n'),
          mapBytes: 8,
        },
      ],
    });
    expect(build.uncovered).toEqual(["chunks/uncovered.js"]);
    expect([...build.mapPaths.keys()]).toEqual(
      build.manifest.artifacts.map((item) => item.url),
    );
  });

  it("rejects a prefix without its trailing slash", async () => {
    const root = await fixture();
    await writeFile(join(root, "chunks", "cart.js"), "x");
    await writeFile(join(root, "chunks", "cart.js.map"), "{}");
    await expect(
      collectBuild({
        buildId: "b",
        root,
        urlPrefix: "https://cdn.example/static",
      }),
    ).rejects.toThrow("url_prefix_must_end_with_slash");
  });

  it("rejects orphan maps and a build with no pairs", async () => {
    const orphanRoot = await fixture();
    await writeFile(join(orphanRoot, "chunks", "orphan.js.map"), "{}");
    await expect(
      collectBuild({
        buildId: "b",
        root: orphanRoot,
        urlPrefix: "https://cdn.example/",
      }),
    ).rejects.toThrow("orphan_source_map");
    const emptyRoot = await fixture();
    await expect(
      collectBuild({
        buildId: "b",
        root: emptyRoot,
        urlPrefix: "https://cdn.example/",
      }),
    ).rejects.toThrow("no_source_map_pairs");
  });

  it("rejects symlinks escaping root and directory cycles", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "everframe-outside-"));
    await writeFile(join(outside, "escape.js"), "x");
    await symlink(
      join(outside, "escape.js"),
      join(root, "chunks", "escape.js"),
    );
    await expect(
      collectBuild({ buildId: "b", root, urlPrefix: "https://cdn.example/" }),
    ).rejects.toThrow("symlink_escapes_root");

    const cycleRoot = await fixture();
    await symlink(cycleRoot, join(cycleRoot, "chunks", "cycle"));
    await expect(
      collectBuild({
        buildId: "b",
        root: cycleRoot,
        urlPrefix: "https://cdn.example/",
      }),
    ).rejects.toThrow("symlink_cycle");
  });

  it("enforces the aggregate 256 MiB map limit", async () => {
    const root = await fixture();
    for (let index = 0; index < 9; index += 1) {
      const js = join(root, "chunks", `${index}.js`);
      const map = `${js}.map`;
      await writeFile(js, "x");
      await writeFile(map, "");
      await truncate(map, 32 * 1024 * 1024);
    }
    await expect(
      collectBuild({ buildId: "b", root, urlPrefix: "https://cdn.example/" }),
    ).rejects.toThrow("build_too_large");
  }, 15_000);
});

it("rejects a sparse map one byte above the local 32 MiB stat limit", async () => {
  const root = await fixture();
  const js = join(root, "chunks", "large.js");
  await writeFile(js, "x");
  await writeFile(`${js}.map`, "");
  await truncate(`${js}.map`, 32 * 1024 * 1024 + 1);
  await expect(
    collectBuild({ buildId: "b", root, urlPrefix: "https://cdn.example/" }),
  ).rejects.toThrow("source_map_too_large");
});

describe("collectBuild without a url prefix", () => {
  it("uses path-only urls when no url prefix is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "evf-manifest-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "assets", "a b.js"), "x");
    await writeFile(join(root, "assets", "a b.js.map"), "{}");
    const local = await collectBuild({ buildId: "b1", root });
    expect(local.manifest.artifacts.map((a) => a.url)).toEqual([
      "~/assets/a%20b.js",
    ]);
    expect(local.mapPaths.get("~/assets/a%20b.js")).toBe(
      join(await realpath(root), "assets", "a b.js.map"),
    );
  });
});
