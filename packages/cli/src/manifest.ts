// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  normalizeAssetUrl,
  parseManifest,
  type SourceMapManifest,
  type SourceMapManifestV1,
} from "@everframe/protocol";
import type { UploadOptions } from "./upload.js";

export interface LocalBuild {
  manifest: SourceMapManifest;
  mapPaths: Map<string, string>;
  generatedPaths?: Map<string, string>;
  fileRoots?: Map<string, { generatedRoot?: string; mapRoot: string }>;
  uncovered: string[];
}

const MAP_MAX_BYTES = 32 * 1024 * 1024;
const BUILD_MAX_BYTES = 256 * 1024 * 1024;

function isInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child === "" ||
    (!child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child))
  );
}

export async function checkedRealPath(
  root: string,
  path: string,
): Promise<string> {
  const resolved = await realpath(path);
  if (!isInside(root, resolved)) throw new Error("symlink_escapes_root");
  return resolved;
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export async function collectBuild(
  options: Pick<UploadOptions, "buildId" | "root" | "urlPrefix">,
): Promise<LocalBuild> {
  if (!options.urlPrefix.endsWith("/"))
    throw new Error("url_prefix_must_end_with_slash");
  let prefix: URL;
  try {
    prefix = new URL(options.urlPrefix);
  } catch {
    throw new Error("invalid_url_prefix");
  }
  if (prefix.username || prefix.password || prefix.search || prefix.hash) {
    throw new Error("invalid_url_prefix");
  }

  const root = await realpath(resolve(options.root));
  const files = new Map<string, string>();
  const activeDirectories = new Set<string>();

  async function walk(
    directoryPath: string,
    relativeDirectory: string,
  ): Promise<void> {
    const directoryRealPath = await checkedRealPath(root, directoryPath);
    if (activeDirectories.has(directoryRealPath))
      throw new Error("symlink_cycle");
    activeDirectories.add(directoryRealPath);
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true });
      entries.sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      );
      for (const entry of entries) {
        const path = resolve(directoryPath, entry.name);
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const metadata = entry.isSymbolicLink()
          ? await stat(path)
          : await lstat(path);
        if (entry.isSymbolicLink()) await checkedRealPath(root, path);
        if (metadata.isDirectory()) await walk(path, relativePath);
        else if (metadata.isFile()) files.set(relativePath, path);
      }
    } finally {
      activeDirectories.delete(directoryRealPath);
    }
  }
  await walk(root, "");

  const orphan = [...files.keys()].filter(
    (path) => path.endsWith(".js.map") && !files.has(path.slice(0, -4)),
  );
  if (orphan.length > 0) throw new Error(`orphan_source_map:${orphan[0]}`);

  const pairs = [...files.keys()].filter(
    (path) => path.endsWith(".js") && files.has(`${path}.map`),
  );
  if (pairs.length === 0) throw new Error("no_source_map_pairs");
  const uncovered = [...files.keys()].filter(
    (path) => path.endsWith(".js") && !files.has(`${path}.map`),
  );

  let totalBytes = 0;
  const artifacts: SourceMapManifestV1["artifacts"] = [];
  const mapPathsByUrl = new Map<string, string>();
  const generatedPathsByUrl = new Map<string, string>();
  for (const generatedRelative of pairs) {
    const generatedPath = files.get(generatedRelative)!;
    const mapPath = files.get(`${generatedRelative}.map`)!;
    const mapBytes = (await stat(mapPath)).size;
    if (mapBytes <= 0 || mapBytes > MAP_MAX_BYTES)
      throw new Error("source_map_too_large");
    totalBytes += mapBytes;
    if (totalBytes > BUILD_MAX_BYTES) throw new Error("build_too_large");
    const url = normalizeAssetUrl(
      new URL(encodePath(generatedRelative), prefix).href,
    );
    artifacts.push({
      url,
      generatedSha256: await hashFile(generatedPath),
      mapSha256: await hashFile(mapPath),
      mapBytes,
    });
    mapPathsByUrl.set(url, mapPath);
    generatedPathsByUrl.set(url, generatedPath);
  }
  const manifest = parseManifest({
    version: 1,
    buildId: options.buildId,
    artifacts,
  });
  const mapPaths = new Map(
    manifest.artifacts.map((artifact) => [
      artifact.url,
      mapPathsByUrl.get(artifact.url)!,
    ]),
  );
  const generatedPaths = new Map(
    manifest.artifacts.map((artifact) => [
      artifact.url,
      generatedPathsByUrl.get(artifact.url)!,
    ]),
  );
  const fileRoots = new Map(
    manifest.artifacts.map((artifact) => [
      artifact.url,
      { generatedRoot: root, mapRoot: root },
    ]),
  );
  return { manifest, mapPaths, generatedPaths, fileRoots, uncovered };
}
