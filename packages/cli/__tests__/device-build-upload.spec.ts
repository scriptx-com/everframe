// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeviceBuildWaitTimeoutError,
  getDeviceBuildUpload,
  uploadDeviceBuild,
  type DeviceBuildUploadOptions,
} from '../src/device-build-upload.js';

const appId = '00000000-0000-4000-8000-000000000001';
const uploadId = '00000000-0000-4000-8000-000000000002';
const buildId = '00000000-0000-4000-8000-000000000003';
const token = 'evf_api_fixture-private-token';
const route = `/api/v1/apps/${appId}/device-builds`;
const apkFixture = Buffer.from('PK\u0003\u0004fixture-apk-bytes');
const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];

function status(state = 'queued') {
  return {
    uploadId,
    state,
    createdAt: '2026-10-16T12:00:00Z',
    updatedAt: '2026-10-16T12:00:01Z',
    ...(state === 'ready' ? { buildId } : {}),
  };
}
function receipt() {
  return {
    uploadId,
    state: 'receiving',
    contentPath: `${route}/${uploadId}/content`,
    statusPath: `${route}/${uploadId}`,
    expiresAt: '2099-01-01T00:00:00Z',
  };
}
function json(res: ServerResponse, code: number, body: unknown, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}
interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  bytes: Buffer;
  body: Record<string, unknown>;
}
async function fixture(
  respond?: (request: RecordedRequest, res: ServerResponse) => void | Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'everframe-device-upload-'));
  directories.push(root);
  const file = join(root, 'app.APK');
  await writeFile(file, apkFixture);
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const request = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        bytes,
        body:
          req.method === 'POST' ? (JSON.parse(bytes.toString()) as Record<string, unknown>) : {},
      };
      requests.push(request);
      if (respond) await respond(request, res);
      else
        json(res, req.method === 'POST' ? 201 : 202, req.method === 'POST' ? receipt() : status());
    })().catch(() => res.destroy());
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address');
  const options: DeviceBuildUploadOptions = {
    apiUrl: `http://127.0.0.1:${address.port}/api/v1`,
    token,
    appId,
    platform: 'android',
    file,
    version: '1.2.3',
    buildNumber: '42',
    projectRoot: root,
  };
  return { options, requests, root, file };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    directories.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('runnable build upload transport', () => {
  it('uploads exact bytes and digest without requiring Git or CI provenance', async () => {
    for (const key of ['GITHUB_SHA', 'CI_COMMIT_SHA', 'BITBUCKET_COMMIT', 'BUILD_SOURCEVERSION'])
      vi.stubEnv(key, '');
    const { options, requests } = await fixture();
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ uploadId, state: 'queued' });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT']);
    expect(requests[0]!.url).toBe(route);
    expect(requests[0]!.body).toEqual({
      platform: 'android',
      version: '1.2.3',
      buildNumber: '42',
      filename: 'app.APK',
      sizeBytes: apkFixture.length,
      sha256: createHash('sha256').update(apkFixture).digest('hex'),
    });
    expect(requests[0]!.body.commit).toBeUndefined();
    expect(requests[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(requests[1]!.bytes).toEqual(apkFixture);
    expect(requests[1]!.headers['content-length']).toBe(String(apkFixture.length));
    expect(requests[1]!.headers['content-type']).toBe('application/octet-stream');
    expect(requests.every((request) => request.headers.authorization === `Bearer ${token}`)).toBe(
      true,
    );
  });

  it.each(['detected', 'explicit'] as const)('records a %s full commit', async (kind) => {
    const { options, requests, root } = await fixture();
    execFileSync('git', ['init', '--quiet', root]);
    execFileSync('git', [
      '-C',
      root,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      'commit',
      '--allow-empty',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    if (kind === 'explicit') options.commit = 'A'.repeat(40);
    await uploadDeviceBuild(options);
    expect(requests[0]!.body.commit).toBe(kind === 'explicit' ? 'a'.repeat(40) : head);
  });

  it('hashes and streams every chunk of a large package', async () => {
    const { options, requests } = await fixture();
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 123, 37);
    bytes[65536] = 99;
    bytes[bytes.length - 1] = 42;
    await writeFile(options.file, bytes);
    await uploadDeviceBuild(options);
    expect(requests[0]!.body.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(requests[0]!.body.sizeBytes).toBe(bytes.length);
    expect(requests[1]!.bytes).toEqual(bytes);
  });

  it('distinguishes asynchronous acceptance from readiness and reports safe status updates', async () => {
    let gets = 0;
    let acceptedAt = 0;
    let polledAt = 0;
    const { options } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'PUT') {
        acceptedAt = Date.now();
        json(res, 202, status());
      } else {
        gets++;
        polledAt = Date.now();
        json(res, 200, status('ready'));
      }
    });
    const updates: string[] = [];
    await expect(
      uploadDeviceBuild({ ...options, wait: true, onStatus: (value) => updates.push(value.state) }),
    ).resolves.toMatchObject({ state: 'ready', buildId });
    expect(gets).toBe(1);
    expect(polledAt - acceptedAt).toBeGreaterThanOrEqual(2000);
    expect(updates).toEqual(['queued', 'ready']);
  });

  it('recovers a lost PUT response without uploading accepted bytes twice', async () => {
    let acceptedUploadCount = 0;
    const { options, requests } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'PUT') {
        acceptedUploadCount++;
        res.destroy();
      } else json(res, 200, status());
    });
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ state: 'queued' });
    expect(acceptedUploadCount).toBe(1);
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'GET']);
  });

  it('recovers an interrupted PUT response body without replaying accepted bytes', async () => {
    let acceptedUploadCount = 0;
    const { options } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'PUT') {
        acceptedUploadCount++;
        res.writeHead(202, { 'content-length': '1000' });
        res.write('{');
        setTimeout(() => res.destroy(), 10);
      } else json(res, 200, status());
    });
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ state: 'queued' });
    expect(acceptedUploadCount).toBe(1);
  });

  it('retries abandoned content on the same upload only after GET confirms receiving', async () => {
    let puts = 0;
    const { options, requests } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'GET') json(res, 200, status('receiving'));
      else if (++puts === 1) res.destroy();
      else json(res, 202, status());
    });
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ state: 'queued' });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT', 'GET', 'PUT']);
    expect(
      requests.filter((request) => request.method === 'PUT').map((request) => request.url),
    ).toEqual([`${route}/${uploadId}/content`, `${route}/${uploadId}/content`]);
    expect(
      requests
        .filter((request) => request.method === 'PUT')
        .every((request) => request.bytes.equals(apkFixture)),
    ).toBe(true);
  });

  it('rejects a changed source file before streaming it', async () => {
    const { options, requests } = await fixture(async (request, res) => {
      if (request.method === 'POST') {
        await writeFile(options.file, Buffer.alloc(apkFixture.length, 65));
        json(res, 201, receipt());
      }
    });
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({ code: 'source_file_changed' });
    expect(requests.map((request) => request.method)).toEqual(['POST']);
  });

  it('keeps the opened file when its pathname is replaced', async () => {
    const { options, requests } = await fixture(async (request, res) => {
      if (request.method === 'POST') {
        await rename(options.file, `${options.file}.old`);
        await writeFile(options.file, 'unrelated replacement');
        json(res, 201, receipt());
      } else json(res, 202, status());
    });
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({ code: 'source_file_changed' });
    expect(requests.filter((request) => request.method === 'PUT')).toHaveLength(0);
  });

  it('detects source mutation during the content request', async () => {
    const { options } = await fixture(async (request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else {
        await writeFile(options.file, Buffer.alloc(apkFixture.length, 65));
        json(res, 202, status());
      }
    });
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({ code: 'source_file_changed' });
  });

  it('refuses a content redirect without sending bytes or credentials to its destination', async () => {
    const destination = await fixture();
    const { options, requests } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else res.writeHead(307, { location: `${destination.options.apiUrl}/stolen` }).end();
    });
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({
      code: 'request_failed',
      statusCode: 307,
    });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT']);
    expect(destination.requests).toHaveLength(0);
  });

  it.each(['off-origin', 'other-app', 'redirect'] as const)(
    'refuses %s paths without sending credentials there',
    async (kind) => {
      const destination = await fixture();
      const { options } = await fixture((_request, res) => {
        if (kind === 'redirect') {
          res.writeHead(307, { location: `${destination.options.apiUrl}/stolen` }).end();
        } else {
          const value = receipt();
          if (kind === 'off-origin') value.contentPath = `${destination.options.apiUrl}/stolen`;
          else {
            value.contentPath = value.contentPath.replace(appId, buildId);
            value.statusPath = value.statusPath.replace(appId, buildId);
          }
          json(res, 201, value);
        }
      });
      await expect(uploadDeviceBuild(options)).rejects.toMatchObject({
        code: kind === 'redirect' ? 'request_failed' : 'invalid_server_response',
      });
      expect(destination.requests).toHaveLength(0);
    },
  );

  it('redacts untrusted error bodies and does not retry permanent 4xx', async () => {
    const { options, requests } = await fixture((_request, res) =>
      json(res, 403, { error: token, message: `raw ${token}` }),
    );
    const error = await uploadDeviceBuild(options).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'request_failed', statusCode: 403 });
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(requests).toHaveLength(1);
  });

  it('replaces untrusted status messages with safe messages before callbacks and return', async () => {
    const { options } = await fixture((_request, res) =>
      json(res, 200, {
        ...status('failed'),
        error: { code: 'provider_unavailable', message: `raw response ${token}` },
      }),
    );
    const captured: unknown[] = [];
    const result = await uploadDeviceBuild({
      ...options,
      onStatus: (value) => captured.push(value),
    });
    expect(result).toMatchObject({ state: 'failed', error: { code: 'provider_unavailable' } });
    expect(JSON.stringify([result, captured])).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain('raw response');
  });

  it('preserves the upload ID and last queued status on a wait timeout', async () => {
    const { options } = await fixture();
    const timeout = await uploadDeviceBuild({ ...options, wait: true, timeout: 0.1 }).catch(
      (value: unknown) => value,
    );
    expect(timeout).toBeInstanceOf(DeviceBuildWaitTimeoutError);
    expect(timeout).toMatchObject({ uploadId, lastStatus: { state: 'queued' } });
  });

  it('does not resume a replay that is already accepted', async () => {
    const { options, requests } = await fixture((_request, res) => json(res, 200, status()));
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ state: 'queued' });
    expect(requests.map((request) => request.method)).toEqual(['POST']);
  });

  it('resumes a reservation replay that is still receiving', async () => {
    const { options, requests } = await fixture((request, res) =>
      json(res, 200, request.method === 'POST' ? status('receiving') : status()),
    );
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ state: 'queued' });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT']);
    expect(requests[1]!.bytes).toEqual(apkFixture);
  });

  it('reuses one reservation key across bounded transient retries', async () => {
    let posts = 0;
    const { options, requests } = await fixture((request, res) => {
      if (request.method !== 'POST') json(res, 202, status());
      else if (++posts < 3) json(res, 503, { error: token });
      else json(res, 201, receipt());
    });
    await expect(uploadDeviceBuild(options)).resolves.toMatchObject({ state: 'queued' });
    const reservations = requests.filter((request) => request.method === 'POST');
    expect(reservations).toHaveLength(3);
    expect(new Set(reservations.map((request) => request.headers['idempotency-key'])).size).toBe(1);
  });

  it('bounds transient failures at three requests', async () => {
    const { options, requests } = await fixture((_request, res) =>
      json(res, 503, { error: token }),
    );
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({
      code: 'request_failed',
      statusCode: 503,
    });
    expect(requests).toHaveLength(3);
  });

  it('does not retransmit a permanent PUT conflict', async () => {
    const { options, requests } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'PUT') json(res, 409, { error: 'conflict' });
      else json(res, 200, status('receiving'));
    });
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({
      code: 'request_failed',
      statusCode: 409,
    });
    expect(requests.map((request) => request.method)).toEqual(['POST', 'PUT']);
  });

  it('honors a larger Retry-After while polling', async () => {
    let acceptedAt = 0;
    let polledAt = 0;
    const { options } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'PUT') {
        acceptedAt = Date.now();
        json(res, 202, status(), { 'retry-after': '3' });
      } else {
        polledAt = Date.now();
        json(res, 200, status('ready'));
      }
    });
    await expect(uploadDeviceBuild({ ...options, wait: true })).resolves.toMatchObject({
      state: 'ready',
    });
    expect(polledAt - acceptedAt).toBeGreaterThanOrEqual(3000);
  });

  it('keeps the original total deadline across reservation retries', async () => {
    let posts = 0;
    const { options, requests } = await fixture((_request, res) => {
      posts++;
      json(res, posts === 1 ? 503 : 201, posts === 1 ? { error: 'busy' } : receipt(), {
        'retry-after': '1',
      });
    });
    const started = Date.now();
    await expect(uploadDeviceBuild({ ...options, timeout: 0.1 })).rejects.toMatchObject({
      code: 'upload_timeout',
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(requests).toHaveLength(1);
  });

  it('retains the last safe status when the deadline expires inside a GET', async () => {
    const { options } = await fixture((request, res) => {
      if (request.method === 'POST') json(res, 201, receipt());
      else if (request.method === 'PUT') json(res, 202, status());
    });
    await expect(uploadDeviceBuild({ ...options, wait: true, timeout: 2.1 })).rejects.toMatchObject(
      {
        code: 'wait_timeout',
        uploadId,
        lastStatus: { state: 'queued' },
      },
    );
  });

  it.each(['ios', 'tvos', 'roku', 'android-tv'] as const)(
    'streams a supported %s package',
    async (platform) => {
      const { options, requests, root } = await fixture();
      const file = join(root, platform === 'android-tv' ? 'app.apk' : 'simulator.ZIP');
      await writeFile(file, apkFixture);
      await expect(uploadDeviceBuild({ ...options, file, platform })).resolves.toMatchObject({
        state: 'queued',
      });
      expect(requests[0]!.body.platform).toBe(platform);
      expect(requests[1]!.bytes).toEqual(apkFixture);
    },
  );

  it.each([
    'https://user:password@example.test/api/v1',
    'http://example.test/api/v1',
    'https://example.test/api/v1?token=secret',
  ])('rejects unsafe API configuration %s', async (apiUrl) => {
    const { options, requests } = await fixture();
    await expect(uploadDeviceBuild({ ...options, apiUrl })).rejects.toMatchObject({
      code: 'invalid_api_url',
    });
    expect(requests).toHaveLength(0);
  });

  it.each([
    { ...status('ready'), buildId: undefined },
    { ...status(), unexpected: 'field' },
    { ...status(), uploadId: buildId },
  ])('rejects a schema-invalid or mismatched status response', async (body) => {
    const { options, requests } = await fixture((_request, res) => json(res, 200, body));
    await expect(getDeviceBuildUpload({ ...options, uploadId })).rejects.toMatchObject({
      code: 'invalid_server_response',
    });
    expect(requests).toHaveLength(1);
  });

  it.each([
    { file: 'app.aab', platform: 'android', code: 'invalid_format', message: 'APK' },
    { file: 'app.ipa', platform: 'ios', code: 'invalid_format', message: 'simulator' },
    { commit: 'short', code: 'invalid_commit', message: '40' },
    { version: '', code: 'invalid_input', message: 'invalid_input' },
    { appId: '../other-app', code: 'invalid_input', message: 'invalid_input' },
  ])('rejects invalid local input before requests: %j', async ({ code, message, ...input }) => {
    const { options, requests } = await fixture();
    const error = await uploadDeviceBuild({
      ...options,
      ...input,
    } as DeviceBuildUploadOptions).catch((value: unknown) => value);
    expect(error).toMatchObject({ code });
    expect(String(error)).toContain(message);
    expect(requests).toHaveLength(0);
  });

  it.each([0, 524288001])('rejects a %i-byte source before requests', async (size) => {
    const { options, requests } = await fixture();
    await truncate(options.file, size);
    await expect(uploadDeviceBuild(options)).rejects.toMatchObject({
      code: size === 0 ? 'invalid_input' : 'upload_too_large',
    });
    expect(requests).toHaveLength(0);
  });

  it('uses the status endpoint and refuses a different upload ID in its response', async () => {
    const { options, requests } = await fixture((_request, res) => json(res, 200, status('ready')));
    await expect(getDeviceBuildUpload({ ...options, uploadId })).resolves.toMatchObject({
      state: 'ready',
      buildId,
    });
    expect(requests[0]!.method).toBe('GET');
    expect(requests[0]!.url).toBe(`${route}/${uploadId}`);
    await expect(getDeviceBuildUpload({ ...options, uploadId: buildId })).rejects.toMatchObject({
      code: 'invalid_server_response',
    });
  });

  it('bounds chunked response bodies and refuses schema-invalid statuses', async () => {
    const { options, requests } = await fixture((_request, res) => {
      res.writeHead(200);
      res.end(' '.repeat(65537));
    });
    await expect(getDeviceBuildUpload({ ...options, uploadId })).rejects.toMatchObject({
      code: 'invalid_server_response',
    });
    expect(requests).toHaveLength(1);
  });

  it('aborts an unanswered request without leaking network diagnostics', async () => {
    const { options } = await fixture(() => undefined);
    const controller = new AbortController();
    const promise = getDeviceBuildUpload({ ...options, uploadId, signal: controller.signal });
    setTimeout(() => controller.abort(new Error(token)), 25);
    const error = await promise.catch((value: unknown) => value);
    expect(error).toMatchObject({ code: 'aborted' });
    expect(String(error)).not.toContain(token);
  });
});
