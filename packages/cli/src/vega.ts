// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Source maps from an Amazon Vega OS build. `react-native build-vega` names
// each bundle by its SHA-256 and leaves, in build/lib/rn-bundles/<BuildType>:
//   <entry>.bundle        the JavaScript bundle (e.g. index.bundle)
//   <id>.bundle.map       its Metro source map, with "x_amazon_bundleId": <id>
//   <entry>.hermes.bundle the bytecode
// Release frames read `<id>.bundle:LINE:COL`, so each map uploads as build
// <id> with the asset hermes://vega/<id>.bundle.
import { open, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { collectHermesBuild } from "./hermes.js";
import { checkedRealPath, hashFile, type LocalBuild } from "./manifest.js";

export const VEGA_DEFAULT_DIR = "build/lib/rn-bundles/Release";
const MAP_NAME = /^([0-9a-f]{64})\.bundle\.map$/;
const MAP_MAX_BYTES = 32 * 1024 * 1024;
const ID_FIELD = /"x_amazon_bundleId"\s*:\s*"([^"]*)"/;

export interface VegaBuild {
  bundleId: string;
  local: LocalBuild;
}

export interface CollectedVegaBuilds {
  builds: VegaBuild[];
  /** Maps no bundle in the directory hashes to: an earlier build's leftovers. */
  stale: string[];
}

/** The id the Vega CLI wrote into the map, read without parsing a 32 MiB JSON. */
async function amazonBundleId(path: string): Promise<string | undefined> {
  const handle = await open(path, "r");
  try {
    const size = (await handle.stat()).size;
    if (size <= 0 || size > MAP_MAX_BYTES) throw new Error("source_map_too_large");
    // addBundleId() rewrites the map with JSON.stringify, which puts the new
    // key last; check the tail first, then the head.
    const window = Math.min(size, 4096);
    const tail = Buffer.alloc(window);
    await handle.read(tail, 0, window, size - window);
    const head = Buffer.alloc(window);
    await handle.read(head, 0, window, 0);
    return ID_FIELD.exec(tail.toString("utf8"))?.[1] ?? ID_FIELD.exec(head.toString("utf8"))?.[1];
  } finally {
    await handle.close();
  }
}

export async function collectVegaBuilds(dir: string): Promise<CollectedVegaBuilds> {
  const root = await realpath(resolve(dir));
  if (!(await stat(root)).isDirectory()) throw new Error("vega_build_dir_not_found");
  const entries = await readdir(root, { withFileTypes: true });
  const maps = entries
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && MAP_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  if (maps.length === 0) throw new Error("vega_source_map_not_found");

  // Every JavaScript bundle in the directory, by content hash.
  const bundles = new Map<string, string>();
  for (const entry of entries) {
    if (!(entry.isFile() || entry.isSymbolicLink())) continue;
    if (!entry.name.endsWith(".bundle") || entry.name.endsWith(".hermes.bundle")) continue;
    const path = await checkedRealPath(root, join(root, entry.name));
    bundles.set(await hashFile(path), join(root, entry.name));
  }

  const builds: VegaBuild[] = [];
  const stale: string[] = [];
  for (const name of maps) {
    const bundleId = MAP_NAME.exec(name)![1]!;
    const mapPath = join(root, name);
    await checkedRealPath(root, mapPath);
    const written = await amazonBundleId(mapPath);
    if (written !== undefined && written !== bundleId) throw new Error("vega_bundle_id_mismatch");
    const bundlePath = bundles.get(bundleId);
    if (!bundlePath) {
      stale.push(bundleId);
      continue;
    }
    builds.push({
      bundleId,
      local: await collectHermesBuild({
        buildId: bundleId,
        platform: "vega",
        bundleName: `${bundleId}.bundle`,
        bundlePath,
        sourceMapPath: mapPath,
      }),
    });
  }
  return { builds, stale };
}
