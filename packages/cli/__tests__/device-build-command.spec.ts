// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const appId = '00000000-0000-4000-8000-000000000001';
const uploadId = '00000000-0000-4000-8000-000000000002';
const buildId = '00000000-0000-4000-8000-000000000003';
const token = 'evf_api_command-fixture-token';
const route = `/api/v1/apps/${appId}/device-builds`;
const bytes = Buffer.from('PK\u0003\u0004command-fixture');
const servers: ReturnType<typeof createServer>[] = [];
const roots: string[] = [];

function status(state = 'queued') {
  return {
    uploadId,
    state,
    createdAt: '2026-10-16T12:00:00Z',
    updatedAt: '2026-10-16T12:00:01Z',
    ...(state === 'ready' ? { buildId } : {}),
  };
}
function respond(res: ServerResponse, code: number, body: unknown) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
async function fixture(options: { putState?: string; getState?: string; reject?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'everframe-device-command-'));
  roots.push(root);
  await writeFile(join(root, 'app.APK'), bytes);
  await writeFile(join(root, 'app.ZIP'), bytes);
  const requests: {
    method: string;
    url: string;
    authorization: string | undefined;
    bytes: Buffer;
  }[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({
        method: req.method!,
        url: req.url!,
        authorization: req.headers.authorization,
        bytes: Buffer.concat(chunks),
      });
      if (req.method === options.reject) return respond(res, 403, { message: token });
      if (req.method === 'POST' && req.url === route)
        return respond(res, 201, {
          uploadId,
          state: 'receiving',
          contentPath: `${route}/${uploadId}/content`,
          statusPath: `${route}/${uploadId}`,
          expiresAt: '2099-01-01T00:00:00Z',
        });
      if (req.method === 'PUT' && req.url === `${route}/${uploadId}/content`)
        return respond(res, 202, status(options.putState));
      if (req.method === 'GET' && req.url === `${route}/${uploadId}`) {
        const result = status(options.getState ?? 'ready');
        return respond(res, 200, {
          ...result,
          ...(['failed', 'expired'].includes(result.state)
            ? { error: { code: 'invalid_content', message: token } }
            : {}),
        });
      }
      respond(res, 404, {});
    })().catch(() => res.destroy());
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture_address');
  const env = {
    ...process.env,
    EVERFRAME_API_TOKEN: token,
    EVERFRAME_APP_ID: appId,
    EVERFRAME_API_URL: `http://127.0.0.1:${address.port}/api/v1`,
    GITHUB_SHA: '',
    CI_COMMIT_SHA: '',
    BITBUCKET_COMMIT: '',
    BUILD_SOURCEVERSION: '',
  };
  async function cli(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const child = spawn(
      process.execPath,
      [join(import.meta.dirname, '..', 'dist/index.js'), ...args],
      {
        cwd: root,
        env: { ...env, ...overrides },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    const [exitCode] = await once(child, 'close');
    return {
      exitCode,
      stdout,
      stderr,
      json: stdout.trim().startsWith('{') ? JSON.parse(stdout) : undefined,
    };
  }
  const args = [
    'device-builds',
    'upload',
    '--platform',
    'android',
    '--file',
    'app.APK',
    '--version',
    '1.2.3',
    '--build-number',
    '0042',
  ];
  return { cli, args, requests, root };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('uploads exact bytes with environment credentials and app ID, preserving string metadata', async () => {
  const { cli, args, requests } = await fixture();
  const result = await cli([...args, '--commit', 'B'.repeat(40), '--json']);
  expect(result).toMatchObject({ exitCode: 0, json: { uploadId, state: 'queued' }, stderr: '' });
  expect(requests.map(({ method, url }) => [method, url])).toEqual([
    ['POST', route],
    ['PUT', `${route}/${uploadId}/content`],
  ]);
  expect(requests.every(({ authorization }) => authorization === `Bearer ${token}`)).toBe(true);
  expect(JSON.parse(requests[0]!.bytes.toString())).toMatchObject({
    platform: 'android',
    version: '1.2.3',
    buildNumber: '0042',
    commit: 'b'.repeat(40),
    filename: 'app.APK',
  });
  expect(requests[1]!.bytes).toEqual(bytes);
  expect(result.stdout).not.toContain(token);
});

it('lets an explicit app ID override the environment', async () => {
  const { cli, args } = await fixture();
  expect(
    await cli([...args, '--app-id', appId, '--json'], { EVERFRAME_APP_ID: 'invalid' }),
  ).toMatchObject({ exitCode: 0, json: { uploadId, state: 'queued' } });
});

it('reports queued human output without claiming readiness', async () => {
  const { cli, args } = await fixture();
  const result = await cli(args);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(uploadId);
  expect(result.stdout).toContain('queued');
  expect(result.stdout).not.toContain('ready');
});

it.each([
  ['ios', 'app.ipa', 'simulator .app'],
  ['tvos', 'app.ipa', 'simulator .app'],
  ['android', 'app.aab', 'APK'],
  ['android-tv', 'app.aab', 'APK'],
])('explains the replacement for a %s store package', async (platform, file, replacement) => {
  const { cli, requests } = await fixture();
  const result = await cli([
    'device-builds',
    'upload',
    '--platform',
    platform,
    '--file',
    file,
    '--version',
    '1',
    '--build-number',
    '2',
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(replacement);
  expect(requests).toHaveLength(0);
});

it.each(['ios', 'tvos', 'roku', 'android-tv'])(
  'uploads a supported package for %s',
  async (platform) => {
    const { cli, args, requests } = await fixture();
    const result = await cli([
      ...args.map((value) =>
        value === 'android'
          ? platform
          : value === 'app.APK' && platform !== 'android-tv'
            ? 'app.ZIP'
            : value,
      ),
      '--json',
    ]);
    expect(result).toMatchObject({ exitCode: 0, json: { uploadId, state: 'queued' } });
    expect(JSON.parse(requests[0]!.bytes.toString())).toMatchObject({ platform });
  },
);

it('waits for ready and reports the runnable build ID', async () => {
  const { cli, args, requests } = await fixture();
  expect(await cli([...args, '--wait', '--json'])).toMatchObject({
    exitCode: 0,
    json: { uploadId, state: 'ready', buildId },
    stderr: '',
  });
  expect(requests.map(({ method }) => method)).toEqual(['POST', 'PUT', 'GET']);
});

it.each([false, true])(
  'returns exit 2 with recovery after an accepted wait timeout (json=%s)',
  async (json) => {
    const { cli, args } = await fixture({ getState: 'queued' });
    const result = await cli([...args, '--wait', '--timeout', '1', ...(json ? ['--json'] : [])]);
    expect(result.exitCode).toBe(2);
    const output = json ? result.stdout : result.stderr;
    expect(output).toContain(uploadId);
    expect(output).toContain(
      `everframe device-builds status --app-id ${appId} --upload-id ${uploadId}`,
    );
    if (json)
      expect(result.json).toMatchObject({
        uploadId,
        state: 'queued',
        error: { code: 'wait_timeout', message: expect.any(String) },
      });
    else {
      expect(output).toContain('accepted');
      expect(output).toContain('Last known state: queued.');
      expect(output).not.toMatch(/\b(failed|ready)\b/);
    }
  },
);

it.each(['receiving', 'queued', 'uploading', 'retrying', 'ready', 'failed', 'expired'])(
  'resumes observation of %s using the status command',
  async (state) => {
    const { cli, requests } = await fixture({ getState: state });
    const result = await cli(['device-builds', 'status', '--upload-id', uploadId, '--json']);
    expect(result).toMatchObject({
      exitCode: ['failed', 'expired'].includes(state) ? 1 : 0,
      json: { uploadId, state },
      stderr: '',
    });
    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ['GET', `${route}/${uploadId}`],
    ]);
    expect(result.stdout).not.toContain(token);
    if (['failed', 'expired'].includes(state))
      expect(result.json.error).toMatchObject({
        code: 'invalid_content',
        message: expect.any(String),
      });
  },
);

it.each(['failed', 'expired'])('returns exit 1 for a waited %s upload', async (state) => {
  const { cli, args } = await fixture({ getState: state });
  expect(await cli([...args, '--wait', '--json'])).toMatchObject({
    exitCode: 1,
    json: { uploadId, state, error: { code: 'invalid_content' } },
  });
});

it.each([false, true])(
  'preserves known-ID recovery for a rejected content upload (json=%s)',
  async (json) => {
    const { cli, args } = await fixture({ reject: 'PUT' });
    const result = await cli([...args, ...(json ? ['--json'] : [])]);
    expect(result.exitCode).toBe(1);
    const output = json ? result.stdout : result.stderr;
    expect(output).toContain(uploadId);
    expect(output).toContain('device-builds status');
    expect(output).not.toContain(token);
    if (json)
      expect(result.json).toMatchObject({
        uploadId,
        error: { code: 'request_failed', message: expect.any(String) },
      });
  },
);

it('returns a safe JSON error for a rejected reservation', async () => {
  const { cli, args } = await fixture({ reject: 'POST' });
  const result = await cli([...args, '--json']);
  expect(result).toMatchObject({
    exitCode: 1,
    json: { error: { code: 'request_failed', message: expect.any(String) } },
    stderr: '',
  });
  expect(result.stdout).not.toContain(token);
  expect(result.json).not.toHaveProperty('uploadId');
});

it.each([
  { args: ['--json'], env: { EVERFRAME_API_TOKEN: '' } },
  { args: ['--json', '--timeout', 'NaN'], env: {} },
  { args: ['--json', '--unexpected', token], env: {} },
])('returns a safe JSON validation error before HTTP: %j', async ({ args: extra, env }) => {
  const { cli, args, requests } = await fixture();
  const result = await cli([...args, ...extra], env);
  expect(result).toMatchObject({
    exitCode: 1,
    json: { error: { code: expect.any(String), message: expect.any(String) } },
    stderr: '',
  });
  expect(result.stdout).not.toContain(token);
  expect(requests).toHaveLength(0);
});

it('shows both command syntaxes and the wait default in built help', async () => {
  const { cli } = await fixture();
  const result = await cli(['device-builds', 'upload', '--help']);
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('everframe device-builds upload');
  expect(result.stdout).toContain('everframe device-builds status');
  expect(result.stdout).toContain('600');
});

it.each(['failed', 'expired'])(
  'reports a safe error for an immediately %s upload',
  async (state) => {
    const { cli, args } = await fixture({ putState: state });
    expect(await cli([...args, '--json'])).toMatchObject({
      exitCode: 1,
      json: { uploadId, state, error: { code: expect.any(String), message: expect.any(String) } },
    });
  },
);

it('preserves the last known state after an accepted upload observation fails', async () => {
  const { cli, args } = await fixture({ putState: 'uploading', reject: 'GET' });
  const result = await cli([...args, '--wait']);
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('request_failed');
  expect(result.stderr).toContain('Last known state: uploading.');
  expect(result.stderr).toContain(uploadId);
  expect(result.stderr).toContain(
    `everframe device-builds status --app-id ${appId} --upload-id ${uploadId}`,
  );
  expect(result.stderr).not.toContain(token);
});

it('bounds slow Git provenance by the total deadline before making HTTP requests', async () => {
  const { cli, args, requests, root } = await fixture();
  await writeFile(
    join(root, 'git'),
    `#!${process.execPath}
setTimeout(() => process.stdout.write('${'a'.repeat(40)}\\n'), 3000);
`,
    { mode: 0o755 },
  );
  const started = Date.now();
  const result = await cli([...args, '--timeout', '1', '--json'], {
    PATH: `${root}:${process.env.PATH}`,
  });
  expect(result).toMatchObject({ exitCode: 1, json: { error: { code: 'upload_timeout' } } });
  expect(Date.now() - started).toBeLessThan(1450);
  expect(requests).toHaveLength(0);
});
