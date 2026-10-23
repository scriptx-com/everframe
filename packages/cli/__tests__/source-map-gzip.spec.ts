// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { collectHermesBuild } from '../src/hermes.js';
import { collectBuild, type LocalBuild } from '../src/manifest.js';
import { uploadCollectedBuild } from '../src/upload.js';

const appId = '00000000-0000-4000-8000-000000000001';
const buildUuid = '00000000-0000-4000-8000-000000000002';
const artifactUuid = '00000000-0000-4000-8000-000000000003';
const HBC_MAGIC = Buffer.from([0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f]);
const map = Buffer.from(
  JSON.stringify({ version: 3, sources: ['a.js'], mappings: 'AAAA;'.repeat(50_000) }),
);

async function bodyBytes(body: unknown): Promise<Buffer> {
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function upload(local: LocalBuild, root: string, encodings?: Array<'gzip'>) {
  const url = local.manifest.artifacts[0]!.url;
  const status = (state: 'uploading' | 'ready', available: boolean) => ({
    buildUuid,
    status: state,
    artifacts: [{ artifactUuid, url, available }],
    ...(encodings && { uploadEncodings: encodings }),
  });
  let put: { headers: Record<string, string>; body: Buffer } | undefined;
  const fetcher: typeof fetch = async (_input, init = {}) => {
    if (init.method === 'PUT') {
      put = { headers: init.headers as Record<string, string>, body: await bodyBytes(init.body) };
      return new Response(null, { status: 204 });
    }
    if (!put) return Response.json(status('uploading', false), { status: 201 });
    return Response.json(status('ready', true));
  };
  await uploadCollectedBuild(
    local,
    {
      appId,
      root,
      apiUrl: 'https://api.example.test/api/v1',
      token: 't',
      deleteAfterUpload: false,
    },
    { fetch: fetcher },
  );
  return put!;
}

async function webBuild() {
  const root = await mkdtemp(join(tmpdir(), 'everframe-gzip-web-'));
  await writeFile(join(root, 'app.js'), 'app();\n');
  await writeFile(join(root, 'app.js.map'), map);
  return { root, local: await collectBuild({ buildId: 'b', root }) };
}

async function hermesBuild() {
  const root = await mkdtemp(join(tmpdir(), 'everframe-gzip-hermes-'));
  await mkdir(join(root, 'out'));
  const bundlePath = join(root, 'out', 'index.android.bundle');
  const sourceMapPath = join(root, 'out', 'index.android.bundle.map');
  await writeFile(bundlePath, Buffer.concat([HBC_MAGIC, Buffer.from([0, 1, 2])]));
  await writeFile(sourceMapPath, map);
  const local = await collectHermesBuild({
    buildId: 'b',
    platform: 'android',
    bundleName: 'index.android.bundle',
    bundlePath,
    sourceMapPath,
  });
  return { root, local, sourceMapPath };
}

describe('JavaScript source-map upload encoding', () => {
  it('gzips a web map when the server decodes gzip uploads', async () => {
    const { root, local } = await webBuild();
    const put = await upload(local, root, ['gzip']);
    expect(put.headers['content-encoding']).toBe('gzip');
    expect(put.headers['content-length']).toBe(String(put.body.length));
    expect(put.body.length).toBeLessThan(map.length / 10);
    expect(gunzipSync(put.body)).toEqual(map);
  });

  it('gzips a Hermes map and leaves the file unchanged', async () => {
    const { root, local, sourceMapPath } = await hermesBuild();
    const put = await upload(local, root, ['gzip']);
    expect(put.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(put.body)).toEqual(map);
    expect(await readFile(sourceMapPath)).toEqual(map);
  });

  it('sends identity bytes to a server that lists no encodings', async () => {
    const { root, local } = await webBuild();
    const put = await upload(local, root);
    expect(put.headers['content-encoding']).toBeUndefined();
    expect(put.headers['content-length']).toBe(String(map.length));
    expect(put.body).toEqual(map);
  });
});
