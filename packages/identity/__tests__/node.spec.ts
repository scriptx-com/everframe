// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createIdentityHandler } from '../src/handler.js';
import { toNodeHandler } from '../src/node.js';

const SECRET = 'a'.repeat(64);
const PROJECT_ID = 'proj_01HZY000000000000000000000';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function listen(handler: ReturnType<typeof createIdentityHandler>): Promise<string> {
  const node = toNodeHandler(handler);
  server = createServer((req, res) => void node(req, res));
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'string' || addr === null) throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

describe('toNodeHandler', () => {
  it('serves a token over node:http', async () => {
    const url = await listen(
      createIdentityHandler({ secret: SECRET, projectId: PROJECT_ID, resolveUser: () => ({ id: 'u_alice' }) }),
    );
    const res = await fetch(`${url}/api/traceitx-identity`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json() as { token: string }).token).toBeTypeOf('string');
  });

  it('forwards request headers so bearer auth works', async () => {
    const url = await listen(
      createIdentityHandler({
        secret: SECRET,
        projectId: PROJECT_ID,
        resolveUser: (req) =>
          req.headers.get('authorization') === 'Bearer good' ? { id: 'u_alice' } : null,
      }),
    );
    const ok = await fetch(`${url}/i`, { headers: { authorization: 'Bearer good' } });
    expect((await ok.json() as { token: string | null }).token).toBeTypeOf('string');
    const anon = await fetch(`${url}/i`);
    expect((await anon.json() as { token: string | null }).token).toBeNull();
  });

  it('propagates the status code', async () => {
    const url = await listen(
      createIdentityHandler({
        secret: SECRET, projectId: PROJECT_ID,
        resolveUser: () => { throw new Error('db down'); },
      }),
    );
    expect((await fetch(`${url}/i`)).status).toBe(500);
  });

  it('rejects a POST body over the 1 MiB cap with 413 and never invokes the handler', async () => {
    let invoked = false;
    const url = await listen(
      createIdentityHandler({
        secret: SECRET,
        projectId: PROJECT_ID,
        resolveUser: () => {
          invoked = true;
          return { id: 'u_alice' };
        },
      }),
    );
    const oversized = 'a'.repeat(1024 * 1024 + 10); // just over MAX_BODY_BYTES
    const res = await fetch(`${url}/i`, { method: 'POST', body: oversized });
    expect(res.status).toBe(413);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(invoked).toBe(false);
  });

  it('still accepts a POST body under the cap', async () => {
    const url = await listen(
      createIdentityHandler({
        secret: SECRET,
        projectId: PROJECT_ID,
        resolveUser: () => ({ id: 'u_alice' }),
      }),
    );
    const small = 'a'.repeat(1024);
    const res = await fetch(`${url}/i`, { method: 'POST', body: small });
    expect(res.status).toBe(200);
    expect((await res.json() as { token: string }).token).toBeTypeOf('string');
  });

  it('does not reject and responds sanely when the Host header is malformed', async () => {
    // A real socket won't let us send an invalid Host header, so drive the
    // adapter directly with a stub IncomingMessage/ServerResponse. GET is
    // enough here — no body is read for GET, so the stub needs no readable
    // stream behavior.
    const node = toNodeHandler(
      createIdentityHandler({ secret: SECRET, projectId: PROJECT_ID, resolveUser: () => ({ id: 'u_alice' }) }),
    );

    const req = {
      method: 'GET',
      url: '/i',
      headers: { host: 'exam ple.com' }, // space is invalid in a URL host
    } as unknown as IncomingMessage;

    let ended = false;
    let statusCode = 0;
    const res = {
      headersSent: false,
      set statusCode(v: number) { statusCode = v; },
      get statusCode() { return statusCode; },
      setHeader: () => undefined,
      end: () => { ended = true; },
    } as unknown as ServerResponse;

    await expect(node(req, res)).resolves.toBeUndefined();
    expect(ended).toBe(true);
    expect(statusCode).toBe(200);
  });

  it('responds 500 with an empty body, without rejecting, when the handler itself throws', async () => {
    const node = toNodeHandler(async () => {
      throw new Error('boom');
    });
    server = createServer((req, res) => void node(req, res));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (typeof addr === 'string' || addr === null) throw new Error('no port');
    const url = `http://127.0.0.1:${addr.port}`;

    const res = await fetch(`${url}/i`);
    expect(res.status).toBe(500);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe('');
  });
});
