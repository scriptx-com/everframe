// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { detectBuildVcs } from '@everframe/build-tools';
import {
  DeviceBuildUploadInputSchema,
  DeviceBuildUploadReservationSchema,
  DeviceBuildUploadStatusSchema,
  DevicePlatformSchema,
  type DeviceBuildUploadStatus,
  type DevicePlatform,
} from '@everframe/protocol';
import { redact } from './defaults.js';

export interface DeviceBuildStatusOptions {
  apiUrl: string;
  token: string;
  appId: string;
  uploadId: string;
  signal?: AbortSignal;
}

export interface DeviceBuildUploadOptions {
  apiUrl: string;
  token: string;
  appId: string;
  platform: DevicePlatform;
  file: string;
  version: string;
  buildNumber: string;
  commit?: string;
  projectRoot?: string;
  wait?: boolean;
  /** Total invocation budget in seconds, including reservation and retries. Default: 600. */
  timeout?: number;
  signal?: AbortSignal;
  onStatus?: (status: DeviceBuildUploadStatus) => void;
}

export type DeviceBuildUploadErrorCode =
  | 'invalid_input'
  | 'invalid_api_url'
  | 'missing_api_token'
  | 'invalid_commit'
  | 'invalid_format'
  | 'upload_too_large'
  | 'source_file_unavailable'
  | 'source_file_changed'
  | 'invalid_server_response'
  | 'request_failed'
  | 'request_timeout'
  | 'upload_timeout'
  | 'wait_timeout'
  | 'aborted';

/** Only fixed, safe diagnostics cross the transport boundary. */
export class DeviceBuildUploadError extends Error {
  constructor(
    readonly code: DeviceBuildUploadErrorCode,
    message: string = code,
    readonly statusCode?: number,
    readonly uploadId?: string,
    readonly lastStatus?: DeviceBuildUploadStatus,
  ) {
    super(message);
    this.name = 'DeviceBuildUploadError';
  }
}

/** Acceptance survived the deadline; the caller can continue with the status command. */
export class DeviceBuildWaitTimeoutError extends DeviceBuildUploadError {
  override readonly uploadId: string;
  constructor(override readonly lastStatus: DeviceBuildUploadStatus) {
    super('wait_timeout', 'wait_timeout: upload accepted; check its status to continue.');
    this.name = 'DeviceBuildWaitTimeoutError';
    this.uploadId = lastStatus.uploadId;
  }
}

const MAX_BYTES = 524288000;
const MAX_ATTEMPTS = 3;
const MIN_POLL_MS = 2000;
const DEFAULT_TIMEOUT_SECONDS = 600;
const safeMessages = {
  invalid_format: 'The package format is unsupported for this platform.',
  invalid_content: 'The package contents could not be validated.',
  upload_too_large: 'The package exceeds the upload size limit.',
  upload_expired: 'The upload has expired; start a new upload.',
  provider_unavailable: 'Runnable build processing is temporarily unavailable.',
  retry_exhausted: 'Runnable build processing exhausted its retries.',
} as const;

interface Context {
  base: URL;
  token: string;
  appId: string;
  deadline: number;
  signal: AbortSignal | undefined;
  wait: boolean;
  onStatus: DeviceBuildUploadOptions['onStatus'];
  uploadId?: string;
  lastStatus?: DeviceBuildUploadStatus;
}

function errorWithRecovery(ctx: Context, error: unknown): DeviceBuildUploadError {
  if (error instanceof DeviceBuildWaitTimeoutError) return error;
  const safe =
    error instanceof DeviceBuildUploadError ? error : new DeviceBuildUploadError('request_failed');
  return new DeviceBuildUploadError(
    safe.code,
    safe.message,
    safe.statusCode,
    ctx.uploadId,
    ctx.lastStatus,
  );
}

function context(
  options: Omit<DeviceBuildStatusOptions, 'uploadId'> &
    Pick<DeviceBuildUploadOptions, 'timeout' | 'wait' | 'onStatus'>,
): Context {
  let base: URL;
  try {
    base = new URL(options.apiUrl);
  } catch {
    throw new DeviceBuildUploadError('invalid_api_url');
  }
  const loopback =
    base.hostname === 'localhost' ||
    base.hostname === '[::1]' ||
    (isIP(base.hostname) === 4 && base.hostname.startsWith('127.'));
  if (
    base.username ||
    base.password ||
    base.hash ||
    base.search ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback))
  )
    throw new DeviceBuildUploadError('invalid_api_url');
  base.pathname = base.pathname.replace(/\/$/, '');
  if (!options.token || /[\r\n]/.test(options.token))
    throw new DeviceBuildUploadError('missing_api_token');
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  if (
    !z.uuid().safeParse(options.appId).success ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    timeout > 2147483
  )
    throw new DeviceBuildUploadError('invalid_input');
  return {
    base,
    token: options.token,
    appId: options.appId.toLowerCase(),
    deadline: Date.now() + timeout * 1000,
    signal: options.signal,
    wait: options.wait ?? false,
    onStatus: options.onStatus,
  };
}

function checkBudget(ctx: Context): void {
  if (ctx.signal?.aborted) throw new DeviceBuildUploadError('aborted');
  if (Date.now() >= ctx.deadline) {
    if (ctx.wait && ctx.lastStatus && ctx.lastStatus.state !== 'receiving')
      throw new DeviceBuildWaitTimeoutError(ctx.lastStatus);
    throw new DeviceBuildUploadError('upload_timeout');
  }
}

async function pause(ctx: Context, milliseconds: number): Promise<void> {
  checkBudget(ctx);
  try {
    await sleep(
      Math.min(milliseconds, Math.max(1, ctx.deadline - Date.now())),
      undefined,
      ctx.signal ? { signal: ctx.signal } : {},
    );
  } catch {
    throw new DeviceBuildUploadError('aborted');
  }
  checkBudget(ctx);
}

function buildsUrl(ctx: Context): string {
  return `${ctx.base.href.replace(/\/$/, '')}/apps/${ctx.appId}/device-builds`;
}
function statusUrl(ctx: Context, uploadId: string): string {
  return `${buildsUrl(ctx)}/${uploadId}`;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const raw = response?.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return Math.min(30_000, 250 * 2 ** (attempt - 1) + Math.random() * 250);
}

class RequestFailure extends DeviceBuildUploadError {
  constructor(
    code: 'request_failed' | 'request_timeout',
    readonly retryable: boolean,
    readonly retryAfterMs: number,
    statusCode?: number,
  ) {
    super(code, statusCode ? `${code}: HTTP ${statusCode}` : code, statusCode);
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new DeviceBuildUploadError('invalid_server_response');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) {
        await reader.cancel().catch(() => undefined);
        throw new DeviceBuildUploadError('invalid_server_response');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new DeviceBuildUploadError('invalid_server_response');
  }
}

async function requestOnce(
  ctx: Context,
  url: string,
  init: RequestInit,
  attempt: number,
  streamFactory?: () => Readable,
): Promise<{ body: unknown; retryAfterMs: number }> {
  checkBudget(ctx);
  const timeout = AbortSignal.timeout(
    Math.max(
      1,
      Math.ceil(Math.min(init.method === 'PUT' ? 360_000 : 60_000, ctx.deadline - Date.now())),
    ),
  );
  const signal = ctx.signal ? AbortSignal.any([timeout, ctx.signal]) : timeout;
  let response: Response | undefined;
  let stream: Readable | undefined;
  let closed: Promise<void> | undefined;
  try {
    stream = streamFactory?.();
    closed = stream ? finished(stream).catch(() => undefined) : undefined;
    const streaming: RequestInit & { duplex?: 'half' } = stream
      ? { body: stream as unknown as BodyInit, duplex: 'half' }
      : {};
    response = await fetch(url, {
      ...init,
      ...streaming,
      signal,
      redirect: 'manual',
      credentials: 'omit',
      headers: { authorization: `Bearer ${ctx.token}`, ...init.headers },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new RequestFailure('request_failed', false, 0, response.status);
    }
    if (!response.ok) {
      // Status and Retry-After determine policy. Diagnostic bodies are never
      // needed and cannot turn permanent HTTP errors into network retries.
      await response.body?.cancel().catch(() => undefined);
      throw new RequestFailure(
        'request_failed',
        response.status === 429 || response.status >= 500,
        retryDelay(response, attempt),
        response.status,
      );
    }
    const body = await responseBody(response);
    return { body, retryAfterMs: retryDelay(response, attempt) };
  } catch (error) {
    checkBudget(ctx);
    if (error instanceof DeviceBuildUploadError) throw error;
    throw new RequestFailure(
      timeout.aborted ? 'request_timeout' : 'request_failed',
      true,
      retryDelay(response, attempt),
    );
  } finally {
    stream?.destroy();
    await closed;
  }
}

async function request(ctx: Context, url: string, init: RequestInit) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(ctx, url, init, attempt);
    } catch (error) {
      if (!(error instanceof RequestFailure) || !error.retryable || attempt >= MAX_ATTEMPTS)
        throw error;
      // A status retry is still polling, including recovery after a lost response.
      await pause(
        ctx,
        init.method === 'GET' ? Math.max(MIN_POLL_MS, error.retryAfterMs) : error.retryAfterMs,
      );
    }
  }
}

function parseStatus(ctx: Context, input: unknown, uploadId?: string): DeviceBuildUploadStatus {
  const parsed = DeviceBuildUploadStatusSchema.safeParse(input);
  if (
    !parsed.success ||
    (uploadId && parsed.data.uploadId.toLowerCase() !== uploadId.toLowerCase())
  )
    throw new DeviceBuildUploadError('invalid_server_response');
  const result = parsed.data;
  if (result.error)
    result.error = {
      code: result.error.code,
      message: redact(safeMessages[result.error.code], ctx.token),
    };
  ctx.lastStatus = result;
  return result;
}

function publish(ctx: Context, status: DeviceBuildUploadStatus): void {
  ctx.lastStatus = status;
  ctx.onStatus?.(status);
}

async function readStatus(ctx: Context, uploadId: string) {
  const result = await request(ctx, statusUrl(ctx, uploadId), { method: 'GET' });
  return { status: parseStatus(ctx, result.body, uploadId), retryAfterMs: result.retryAfterMs };
}

/** Read the current state; queued and uploading are distinct from ready. */
export async function getDeviceBuildUpload(
  options: DeviceBuildStatusOptions,
): Promise<DeviceBuildUploadStatus> {
  const ctx = context(options);
  if (!z.uuid().safeParse(options.uploadId).success)
    throw new DeviceBuildUploadError('invalid_input');
  ctx.uploadId = options.uploadId.toLowerCase();
  try {
    return (await readStatus(ctx, ctx.uploadId)).status;
  } catch (error) {
    throw errorWithRecovery(ctx, error);
  }
}

function unchanged(before: BigIntStats, after: BigIntStats): boolean {
  return (
    after.isFile() &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}
async function verifySource(file: FileHandle, path: string, initial: BigIntStats): Promise<void> {
  try {
    if (
      unchanged(initial, await file.stat({ bigint: true })) &&
      unchanged(initial, await stat(path, { bigint: true }))
    )
      return;
  } catch {
    /* A removed or replaced source is a changed source. */
  }
  throw new DeviceBuildUploadError('source_file_changed');
}

function sourceStream(file: FileHandle, sizeBytes: number, ctx: Context): Readable {
  // Stream cleanup owns only the iterator. The descriptor remains open for
  // both passes, retries, and the final mutation check.
  return Readable.from(
    (async function* () {
      for (let position = 0; position < sizeBytes; ) {
        checkBudget(ctx);
        const buffer = Buffer.allocUnsafe(Math.min(65536, sizeBytes - position));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) throw new DeviceBuildUploadError('source_file_changed');
        position += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    })(),
  );
}

function validateFormat(options: DeviceBuildUploadOptions): void {
  if (
    !DevicePlatformSchema.safeParse(options.platform).success ||
    typeof options.file !== 'string' ||
    !options.file
  )
    throw new DeviceBuildUploadError('invalid_input');
  const android = options.platform === 'android' || options.platform === 'android-tv';
  if ((android ? /\.apk$/i : /\.zip$/i).test(options.file)) return;
  const message = android
    ? 'invalid_format: upload an APK; AAB store packages cannot run on a device.'
    : options.platform === 'roku'
      ? 'invalid_format: upload a Roku sideload .zip package.'
      : 'invalid_format: upload a simulator .app bundled in a .zip archive; IPA packages cannot run in a simulator.';
  throw new DeviceBuildUploadError('invalid_format', message);
}

/** Reserve once, stream from a stable descriptor, and optionally wait for readiness. */
export async function uploadDeviceBuild(
  options: DeviceBuildUploadOptions,
): Promise<DeviceBuildUploadStatus> {
  const ctx = context(options);
  validateFormat(options);
  let commit: string | undefined;
  try {
    commit = detectBuildVcs({
      projectRoot: options.projectRoot ?? process.cwd(),
      ...(options.commit === undefined ? {} : { commit: options.commit }),
    })?.commit;
  } catch {
    throw new DeviceBuildUploadError(
      'invalid_commit',
      'invalid_commit: expected a full 40- or 64-character hexadecimal commit.',
    );
  }
  checkBudget(ctx);
  const path = resolve(options.file);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new DeviceBuildUploadError('source_file_unavailable');
  });
  try {
    const initial = await file.stat({ bigint: true });
    if (!initial.isFile() || initial.size < 1n) throw new DeviceBuildUploadError('invalid_input');
    if (initial.size > BigInt(MAX_BYTES)) throw new DeviceBuildUploadError('upload_too_large');
    const sizeBytes = Number(initial.size);
    const hash = createHash('sha256');
    const hashing = sourceStream(file, sizeBytes, ctx);
    try {
      for await (const chunk of hashing) {
        checkBudget(ctx);
        hash.update(chunk);
      }
    } catch (error) {
      if (error instanceof DeviceBuildUploadError) throw error;
      throw new DeviceBuildUploadError('source_file_changed');
    }
    await verifySource(file, path, initial);
    const input = DeviceBuildUploadInputSchema.safeParse({
      platform: options.platform,
      version: options.version,
      buildNumber: options.buildNumber,
      filename: basename(path),
      sizeBytes,
      sha256: hash.digest('hex'),
      ...(commit ? { commit } : {}),
    });
    if (!input.success) throw new DeviceBuildUploadError('invalid_input');
    const reserved = await request(ctx, buildsUrl(ctx), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
      body: JSON.stringify(input.data),
    });
    const reservation = DeviceBuildUploadReservationSchema.safeParse(reserved.body);
    if (!reservation.success) throw new DeviceBuildUploadError('invalid_server_response');
    const reservedUploadId = reservation.data.uploadId;
    ctx.uploadId = reservedUploadId;
    if (!('contentPath' in reservation.data)) parseStatus(ctx, reservation.data);
    let current: DeviceBuildUploadStatus;
    let retryAfterMs = reserved.retryAfterMs;
    if ('contentPath' in reservation.data || reservation.data.state === 'receiving') {
      // Validate the raw path as well as its resolved URL: no alternate origin,
      // app, query, traversal, or encoded route can receive the bearer token.
      const expected = statusUrl(ctx, reservedUploadId);
      if ('contentPath' in reservation.data) {
        const receipt = reservation.data;
        for (const [path, url] of [
          [receipt.contentPath, `${expected}/content`],
          [receipt.statusPath, expected],
        ]) {
          if (
            !path ||
            !url ||
            path !== new URL(url).pathname ||
            new URL(path, ctx.base).href !== url
          )
            throw new DeviceBuildUploadError('invalid_server_response');
        }
      }
      let accepted: DeviceBuildUploadStatus | undefined;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await verifySource(file, path, initial);
        try {
          const result = await requestOnce(
            ctx,
            `${expected}/content`,
            {
              method: 'PUT',
              headers: {
                'content-type': 'application/octet-stream',
                'content-length': String(sizeBytes),
              },
            },
            attempt,
            () => sourceStream(file, sizeBytes, ctx),
          );
          accepted = parseStatus(ctx, result.body, reservedUploadId);
          retryAfterMs = result.retryAfterMs;
        } catch (error) {
          if (!(error instanceof RequestFailure) || !error.retryable) throw error;
          // A failed response does not imply failed storage. Never retransmit
          // bytes until the server confirms that the same upload is receiving.
          const recovered = await readStatus(ctx, reservedUploadId);
          accepted = recovered.status;
          retryAfterMs = Math.max(error.retryAfterMs, recovered.retryAfterMs);
          if (accepted.state === 'receiving' && attempt < MAX_ATTEMPTS) {
            await pause(ctx, Math.max(MIN_POLL_MS, retryAfterMs));
            continue;
          }
          if (accepted.state === 'receiving') throw error;
        }
        await verifySource(file, path, initial);
        if (accepted.state === 'receiving')
          throw new DeviceBuildUploadError('invalid_server_response');
        break;
      }
      if (!accepted) throw new DeviceBuildUploadError('request_failed');
      current = accepted;
    } else {
      current = parseStatus(ctx, reservation.data);
      await verifySource(file, path, initial);
    }
    publish(ctx, current);
    while (options.wait && !['ready', 'failed', 'expired'].includes(current.state)) {
      await pause(ctx, Math.max(MIN_POLL_MS, retryAfterMs));
      const next = await readStatus(ctx, current.uploadId);
      current = next.status;
      retryAfterMs = next.retryAfterMs;
      publish(ctx, current);
    }
    return current;
  } catch (error) {
    throw errorWithRecovery(ctx, error);
  } finally {
    await file.close().catch(() => {
      throw errorWithRecovery(ctx, new DeviceBuildUploadError('source_file_unavailable'));
    });
  }
}
