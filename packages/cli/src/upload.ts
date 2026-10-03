// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, unlink, lstat } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BuildUploadStatus } from "@everframe/protocol";
import { collectBuild, hashFile, type LocalBuild } from "./manifest.js";

export interface UploadOptions {
  appId: string;
  buildId: string;
  root: string;
  urlPrefix: string;
  apiUrl: string;
  token: string;
  deleteAfterUpload: boolean;
}

export interface UploadDependencies {
  fetch?: typeof fetch;
  wait?: (milliseconds: number) => Promise<void>;
}

export type CollectedBuildUploadOptions = Pick<
  UploadOptions,
  "appId" | "root" | "apiUrl" | "token" | "deleteAfterUpload"
>;

class InvalidServerResponse extends Error {
  constructor() {
    super("invalid_server_response");
  }
}

const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 30_000;

function apiBase(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("invalid_api_url");
  }
  const loopback =
    url.hostname === "localhost" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) {
    throw new Error("invalid_api_url");
  }
  return url.href.replace(/\/$/, "");
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_WAIT_MS);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date))
      return Math.min(Math.max(0, date - Date.now()), MAX_WAIT_MS);
  }
  return Math.min(250 * 2 ** (attempt - 1), MAX_WAIT_MS);
}

function parseStatus(input: unknown): BuildUploadStatus {
  if (!input || typeof input !== "object")
    throw new Error("invalid_server_response");
  const value = input as Partial<BuildUploadStatus>;
  if (
    typeof value.buildUuid !== "string" ||
    (value.status !== "uploading" && value.status !== "ready") ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.some(
      (item) =>
        !item ||
        typeof item.artifactUuid !== "string" ||
        typeof item.url !== "string" ||
        typeof item.available !== "boolean",
    )
  )
    throw new Error("invalid_server_response");
  return value as BuildUploadStatus;
}

function validateStatus(status: BuildUploadStatus, urls: string[]): void {
  const remoteUrls = status.artifacts.map((artifact) => artifact.url);
  if (
    new Set(remoteUrls).size !== remoteUrls.length ||
    remoteUrls.length !== urls.length ||
    urls.some((url) => !remoteUrls.includes(url)) ||
    (status.status === "ready" &&
      status.artifacts.some((artifact) => !artifact.available))
  )
    throw new Error("invalid_server_response");
}

function safeErrorCode(
  body: unknown,
  statusCode: number,
  token: string,
): string {
  const reported =
    body &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `http_${statusCode}`;
  return /^[a-z0-9_]{1,80}$/.test(reported) && !reported.includes(token)
    ? reported
    : `http_${statusCode}`;
}

async function responseBody(response: Response): Promise<unknown> {
  // A status echoes at most 500 URLs from a 1 MiB manifest. 2 MiB leaves
  // room for UUIDs/JSON overhead without truncating a valid multi-chunk build.
  // Error diagnostics stay small, and neither path buffers an unbounded body.
  const limit = response.ok ? 2 * 1024 * 1024 : 4096;
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new InvalidServerResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new InvalidServerResponse();
  }
}

async function request(
  fetcher: typeof fetch,
  waiter: (milliseconds: number) => Promise<void>,
  token: string,
  url: string,
  init: RequestInit,
  acceptConflict = false,
): Promise<{ response: Response; body: unknown }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let response: Response | undefined;
    let body: unknown;
    try {
      response = await fetcher(url, {
        ...init,
        redirect: "error",
        headers: { authorization: `Bearer ${token}`, ...init.headers },
      });
      body = response.status === 204 ? undefined : await responseBody(response);
    } catch (error) {
      if (error instanceof InvalidServerResponse) throw error;
      if (attempt === MAX_ATTEMPTS) throw new Error("request_failed:network");
      await waiter(retryDelay(response, attempt));
      continue;
    }
    if (response.ok || (acceptConflict && response.status === 409))
      return { response, body };
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < MAX_ATTEMPTS) {
      await waiter(retryDelay(response, attempt));
      continue;
    }
    const code = safeErrorCode(body, response.status, token);
    throw new Error(`request_failed:${code}`);
  }
  throw new Error("request_failed");
}

async function ensurePathInRoot(root: string, path: string): Promise<string> {
  const rootReal = await realpath(resolve(root));
  const pathReal = await realpath(path);
  const child = relative(rootReal, pathReal);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("symlink_escapes_root");
  }
  return pathReal;
}

// Cleanup must unlink the uploaded file itself. A symlink (including any
// parent below the collection root) could leave private bytes behind or redirect
// deletion. Ordinary uploads continue to support safe in-root symlinks.
async function ensureCleanupPath(root: string, path: string): Promise<void> {
  const rootReal = await realpath(resolve(root));
  await ensurePathInRoot(root, path);
  const child = relative(rootReal, resolve(path));
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw new Error("symlink_cleanup_unsupported");
  let current = rootReal;
  for (const component of child.split(sep)) {
    current = resolve(current, component);
    if ((await lstat(current)).isSymbolicLink())
      throw new Error("symlink_cleanup_unsupported");
  }
}

// Bound every mapping verification, including ready resumes and cleanup. Open
// nonblocking so a replacement FIFO cannot hang before the descriptor stat.
async function readCheckedMapping(
  root: string,
  path: string,
  artifact: { mapBytes: number; mapSha256: string },
): Promise<Buffer> {
  const expected = artifact.mapBytes;
  if (
    !Number.isSafeInteger(expected) ||
    expected <= 0 ||
    expected > 32 * 1024 * 1024
  )
    throw new Error("source_map_changed");
  const resolved = await ensurePathInRoot(root, path);
  const file = await open(
    resolved,
    constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
  ).catch(() => {
    throw new Error("source_map_changed");
  });
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size !== expected)
      throw new Error("source_map_changed");
    // One extra byte detects growth without buffering the growing file. Both
    // metadata checks and reads refer to this descriptor, never a reopened path.
    const bytes = Buffer.allocUnsafe(expected + 1);
    let length = 0;
    for (;;) {
      const { bytesRead } = await file.read(
        bytes,
        length,
        Math.min(64 * 1024, bytes.length - length),
        length,
      );
      length += bytesRead;
      if (length > expected) throw new Error("source_map_changed");
      if (bytesRead === 0) break;
    }
    if (
      length !== expected ||
      (await file.stat()).size !== expected ||
      createHash("sha256").update(bytes.subarray(0, length)).digest("hex") !==
        artifact.mapSha256
    )
      throw new Error("source_map_changed");
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

async function verifyCollectedFiles(
  local: LocalBuild,
  defaultRoot: string,
): Promise<void> {
  for (const artifact of local.manifest.artifacts) {
    const mapPath = local.mapPaths.get(artifact.url);
    if (!mapPath) throw new Error("invalid_local_build");
    const roots = local.fileRoots?.get(artifact.url);
    await readCheckedMapping(roots?.mapRoot ?? defaultRoot, mapPath, artifact);
    if (local.manifest.version === 3) continue;
    const generatedPath = local.generatedPaths?.get(artifact.url);
    if (!generatedPath) throw new Error("invalid_local_build");
    await ensurePathInRoot(roots?.generatedRoot ?? defaultRoot, generatedPath);
    if ((await hashFile(generatedPath)) !== artifact.generatedSha256)
      throw new Error("generated_file_changed");
  }
}

export async function uploadBuild(
  options: UploadOptions,
  dependencies: UploadDependencies = {},
  localBuild?: LocalBuild,
): Promise<BuildUploadStatus> {
  apiBase(options.apiUrl);
  if (!options.token) throw new Error("missing_api_token");
  const local = localBuild ?? (await collectBuild(options));
  return uploadCollectedBuild(local, options, dependencies);
}

export async function uploadCollectedBuild(
  local: LocalBuild,
  options: CollectedBuildUploadOptions,
  dependencies: UploadDependencies = {},
): Promise<BuildUploadStatus> {
  const base = apiBase(options.apiUrl);
  if (!options.token) throw new Error("missing_api_token");
  if (local.manifest.version !== 1 && options.deleteAfterUpload)
    throw new Error("delete_after_upload_unsupported");
  if (options.deleteAfterUpload) {
    for (const artifact of local.manifest.artifacts) {
      const path = local.mapPaths.get(artifact.url);
      if (!path) throw new Error("invalid_local_build");
      await ensureCleanupPath(
        local.fileRoots?.get(artifact.url)?.mapRoot ?? options.root,
        path,
      );
    }
  }
  const fetcher = dependencies.fetch ?? fetch;
  const waiter = dependencies.wait ?? wait;
  const buildsUrl = `${base}/apps/${encodeURIComponent(options.appId)}/source-map-builds`;
  const reserved = await request(fetcher, waiter, options.token, buildsUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(local.manifest),
  });
  let status = parseStatus(reserved.body);
  const manifestUrls = local.manifest.artifacts.map((artifact) => artifact.url);
  validateStatus(status, manifestUrls);
  if (status.status !== "ready") {
    const statusUrl = `${buildsUrl}/${encodeURIComponent(status.buildUuid)}`;
    const artifactByUrl = new Map(
      status.artifacts.map((artifact) => [artifact.url, artifact]),
    );
    for (const artifact of local.manifest.artifacts) {
      const remote = artifactByUrl.get(artifact.url);
      if (!remote) throw new Error("invalid_server_response");
      if (remote.available) continue;
      const mapPath = local.mapPaths.get(artifact.url);
      if (!mapPath) throw new Error("invalid_local_build");
      const roots = local.fileRoots?.get(artifact.url);
      const mapBytes = await readCheckedMapping(
        roots?.mapRoot ?? options.root,
        mapPath,
        artifact,
      );
      const uploadUrl = `${buildsUrl}/${encodeURIComponent(status.buildUuid)}/artifacts/${encodeURIComponent(remote.artifactUuid)}`;
      const uploaded = await request(
        fetcher,
        waiter,
        options.token,
        uploadUrl,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: new Uint8Array(mapBytes),
        },
        true,
      );
      if (uploaded.response.status === 409) {
        const resumed = await request(
          fetcher,
          waiter,
          options.token,
          statusUrl,
          { method: "GET" },
        );
        const current = parseStatus(resumed.body);
        validateStatus(current, manifestUrls);
        const currentArtifact = current.artifacts.find(
          (item) => item.url === artifact.url,
        );
        if (!currentArtifact?.available)
          throw new Error("request_failed:artifact_conflict");
        status = current;
      }
    }
    const completed = await request(
      fetcher,
      waiter,
      options.token,
      `${buildsUrl}/${encodeURIComponent(status.buildUuid)}/complete`,
      { method: "POST" },
      true,
    );
    if (completed.response.status === 409) {
      const resumed = await request(fetcher, waiter, options.token, statusUrl, {
        method: "GET",
      });
      status = parseStatus(resumed.body);
      validateStatus(status, manifestUrls);
      if (status.status !== "ready") {
        const code = safeErrorCode(
          completed.body,
          completed.response.status,
          options.token,
        );
        throw new Error(`request_failed:${code}`);
      }
    } else {
      status = parseStatus(completed.body);
      validateStatus(status, manifestUrls);
    }
  }
  if (status.status !== "ready") throw new Error("build_incomplete");
  await verifyCollectedFiles(local, options.root);

  if (options.deleteAfterUpload) {
    for (const artifact of local.manifest.artifacts) {
      const path = local.mapPaths.get(artifact.url)!;
      const roots = local.fileRoots?.get(artifact.url);
      await readCheckedMapping(roots?.mapRoot ?? options.root, path, artifact);
    }
    for (const artifact of local.manifest.artifacts) {
      const path = local.mapPaths.get(artifact.url)!;
      const roots = local.fileRoots?.get(artifact.url);
      await readCheckedMapping(roots?.mapRoot ?? options.root, path, artifact);
      await ensureCleanupPath(roots?.mapRoot ?? options.root, path);
      await unlink(path);
    }
  }
  return status;
}
