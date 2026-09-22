// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/**
 * Minimal stub ingest server for Playwright e2e specs.
 * Validates Bearer auth, accepts multipart, returns 200 with eventId.
 * Captures the last raw multipart body in memory so specs can assert envelope shape.
 */
export interface StubServer {
  port: number;
  url: string;
  lastEnvelope: () => Buffer | null;
  lastHeaders: () => Record<string, string | string[]>;
  reset: () => void;
  close: () => Promise<void>;
}

export async function startStubIngest(opts: { expectedKey?: string } = {}): Promise<StubServer> {
  let lastBody: Buffer | null = null;
  let lastHeaders: Record<string, string | string[]> = {};
  const expectedKey = opts.expectedKey ?? 'txx_live_test';

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // CORS preflight for cross-origin POSTs from Next.js dev server
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST' || !req.url?.endsWith('/api/ingest')) {
      res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${expectedKey}`) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'invalid_sdk_key' }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    lastBody = Buffer.concat(chunks);
    lastHeaders = { ...req.headers } as Record<string, string | string[]>;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ eventId: 'evt_test', status: 'received' }));
  };

  const srv = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    lastEnvelope: () => lastBody,
    lastHeaders: () => lastHeaders,
    reset: () => {
      lastBody = null;
      lastHeaders = {};
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        srv.close((e) => (e ? reject(e) : resolve()));
      }),
  };
}
