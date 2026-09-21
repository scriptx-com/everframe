// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Static file server for the e2e fixtures, rooted at the PACKAGE directory so
// both entries resolve — `/dist/index.js` and `/dist/browser/index.js` — and,
// more importantly, so the sibling chunks each imports (`./chunk-*.js`, and
// `./react-island-*.js` on open) resolve relative to it. Serving
// `e2e/fixtures/` alone would load an entry and 404 every chunk.
//
// It also serves the two packages the ESM entry reaches by a BARE dynamic
// specifier — `modern-screenshot` and `rrweb`, both real `dependencies` — under
// /vendor/, which plain.html's import map points at. A bundler resolves those
// for a real consumer; a browser loading raw ESM cannot, and the failure is
// silent: capture degrades to the 1x1 transparent placeholder and the
// capture-exclusion spec would then be diffing two blank pixels.
// (script-tag.html needs none of this: the browser entry is built with
// `noExternal: [/.*/]`, so it has nothing bare left to resolve. That is what
// makes it the no-bundler artifact.)
//
// Hand-rolled rather than `http-server`: this is ~60 lines, it adds no
// dependency to a published package's devDependencies, and it pins the three
// things the fixture actually needs — a correct `text/javascript` for ESM
// (a wrong type makes the browser refuse the module), the vendor aliases
// above, and no caching, so a rebuilt dist/ is never served stale from a
// reused server.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.env.E2E_PORT ?? 8899);

/**
 * Bare-specifier stand-ins for the fixture's import map. Resolved through
 * Node's own algorithm (honouring each package's `exports` "import"
 * condition) rather than hard-coded paths, so a dependency bump that moves
 * its ESM entry does not silently reinstate the degraded-capture failure.
 */
const VENDOR = {
  '/vendor/modern-screenshot.js': fileURLToPath(import.meta.resolve('modern-screenshot')),
  '/vendor/rrweb.js': fileURLToPath(import.meta.resolve('rrweb')),
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  // normalize() collapses `..`; the prefix check then refuses anything that
  // still points outside the package directory.
  const file = VENDOR[pathname] ?? join(ROOT, normalize(pathname));
  if (!(pathname in VENDOR) && file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  readFile(file).then(
    (body) => {
      res.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    },
    () => {
      res.writeHead(404).end('not found');
    },
  );
}).listen(PORT, '127.0.0.1', () => {
  console.log(`[e2e] serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
