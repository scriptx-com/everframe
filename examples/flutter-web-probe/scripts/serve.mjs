// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXAMPLE = fileURLToPath(new URL('..', import.meta.url));
const WEB = resolve(EXAMPLE, 'build/web');
const SDK = resolve(EXAMPLE, '../../packages/sdk-web/dist/browser');
const PORT = 8937;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
let lastReport = null;

function respond(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && pathname === '/api/config') {
    respond(res, 200, JSON.stringify({ replayEnabled: true, replayDurationSec: 30, samplingRate: 1 }), 'application/json');
    return;
  }
  if (req.method === 'POST' && pathname === '/api/ingest') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    lastReport = { bytes: Buffer.concat(chunks), contentType: req.headers['content-type'] ?? 'application/octet-stream' };
    respond(res, 200, '{}', 'application/json');
    return;
  }
  if (req.method === 'GET' && pathname === '/probe/last-report') {
    if (lastReport === null) respond(res, 404, 'no report yet');
    else respond(res, 200, lastReport.bytes, lastReport.contentType);
    return;
  }
  if (pathname.startsWith('/api/') || pathname.startsWith('/probe/')) {
    respond(res, 404, 'not found');
    return;
  }

  const sdk = pathname.startsWith('/sdk/');
  const root = sdk ? SDK : WEB;
  const relative = sdk ? pathname.slice('/sdk/'.length) : pathname.slice(1);
  const file = resolve(root, relative || 'index.html');
  if (file !== root && !file.startsWith(root + sep)) {
    respond(res, 403, 'forbidden');
    return;
  }
  try {
    respond(res, 200, await readFile(file), TYPES[extname(file)] ?? 'application/octet-stream');
  } catch {
    respond(res, 404, 'not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Flutter web probe on http://127.0.0.1:${PORT}`);
});
