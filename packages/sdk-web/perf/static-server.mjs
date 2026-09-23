// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Static file server for the vitals perf harness (see README.md). Rooted at
// three places, resolved relative to THIS file via `import.meta.url` so the
// harness has no hard-coded absolute path and works from any checkout or
// worktree:
//
//   /dist/**   -> packages/sdk-web/dist   (the built browser bundle — run
//                 `pnpm --filter @everframe/web build` first, same as e2e's
//                 static-server.mjs requires for its suite)
//   /media/**  -> examples/react-web/public/media (the example app's video
//                 fixture the harness plays to keep the page busy)
//   /vendor/hls.js -> hls.js's own minified dist build, resolved through
//                 Node's module resolution (not a literal node_modules path
//                 join — the repo runs `node-linker=hoisted`, so hls.js
//                 lives at the workspace root's node_modules, not
//                 packages/sdk-web/node_modules). This is a perf-harness-only
//                 devDependency of @everframe/web (see package.json); it is
//                 never a runtime dependency of the shipped SDK.
//   (anything else, e.g. /harness.html) -> this perf/ directory
//
// Modelled on ../e2e/static-server.mjs, but rooted three levels differently:
// that server is one directory below the package root, this one is two
// (packages/sdk-web/perf), and it additionally reaches out to the sibling
// `examples/react-web` package for the media fixture — no chunk-graph
// assertions here, just enough MIME handling to boot a page.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url)); // packages/sdk-web/perf
const PKG_DIR = join(HERE, '..'); // packages/sdk-web
const REPO_DIR = join(HERE, '..', '..', '..'); // repo root
const require = createRequire(import.meta.url);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.css': 'text/css',
};

function resolveFile(pathname) {
  const p = decodeURIComponent(pathname);
  if (p === '/vendor/hls.js') return require.resolve('hls.js/dist/hls.min.js');
  if (p.startsWith('/dist/')) return join(PKG_DIR, normalize(p));
  if (p.startsWith('/media/')) {
    return join(REPO_DIR, 'examples/react-web/public', normalize(p));
  }
  return join(HERE, normalize(p));
}

/**
 * Starts the harness static server. Returns the listening `http.Server` so
 * the caller (vitals-harness.mjs) can `close()` it once the run is done —
 * including on failure, so a crashed run doesn't leave a port bound.
 */
export function startServer(port = Number(process.env.PERF_PORT ?? 8931)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const file = resolveFile(url.pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
        'content-length': body.length,
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end(`not found: ${url.pathname}`);
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => resolve(server));
  });
}

// Allow running this file directly (`node static-server.mjs`) for manual
// poking at the harness page outside of a perf run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PERF_PORT ?? 8931);
  startServer(port).then(() => console.log(`listening on ${port}`));
}
