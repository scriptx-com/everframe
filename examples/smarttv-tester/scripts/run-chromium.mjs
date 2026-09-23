// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Run the tester in a specific Chromium milestone — the closest desktop
// approximation of a TV browser engine (Tizen ships ~47–94, webOS ~38–94
// depending on model year). Downloads the snapshot from Google's
// chromium-browser-snapshots bucket on first use and caches it under
// ~/.everframe/chromium/<version>.
//
//   pnpm run:chromium 69              # vite build + preview, launch Chromium 69 at it
//   pnpm run:chromium 63 --dev        # against the dev server (modern ESM — needs >=63)
//   pnpm run:chromium 47 http://host:1234   # against any URL, no server started
//   pnpm run:chromium 87 --download-only    # just warm the cache
//
// macOS-only: the milestone→snapshot-position map below is for the Mac
// bucket (positions differ per platform), and launch goes through
// `arch -x86_64` because Google publishes no arm64 snapshots for these
// milestones. The flags match the conservative hosted-TV launch profile.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { appRoot, buildWeb, fail, log } from './tv-common.mjs';

// Chromium major -> Mac commit position (chromiumdash fetch_milestones +
// snapshot bucket probe).
const POSITIONS = {
  38: 303752,
  47: 369684,
  53: 403389,
  56: 433084,
  63: 508578,
  68: 561733,
  69: 576753,
  76: 665002,
  79: 706915,
  85: 782801,
  87: 812892,
  94: 911515,
  108: 1058934,
  120: 1217364,
  130: 1356019,
  132: 1381570,
};

const PORT = 4174;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const version = Number(positional[0]);
let url = positional[1];

if (!positional[0] || Number.isNaN(version)) {
  fail(`usage: run-chromium.mjs <version> [url] [--dev|--download-only]
known versions: ${Object.keys(POSITIONS).join(' ')}`);
}
if (!POSITIONS[version]) {
  fail(`unknown chromium version ${version} — known: ${Object.keys(POSITIONS).join(' ')}`);
}
if (process.platform !== 'darwin') {
  fail('snapshot positions in this script are for the Mac bucket — macOS only');
}

function findApp(root) {
  if (!fs.existsSync(root)) return null;
  const queue = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'Chromium.app') return path.join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }
  return null;
}

async function ensureBinary() {
  const root = path.join(os.homedir(), '.everframe', 'chromium', String(version));
  let app = findApp(root);
  if (app) return app;

  fs.mkdirSync(root, { recursive: true });
  const position = POSITIONS[version];
  const zipUrl = `https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/${position}/chrome-mac.zip`;
  const zipPath = path.join(os.tmpdir(), `chromium-${version}-${process.pid}.zip`);
  log(`downloading Chromium ${version} (position ${position})`);
  log(zipUrl);
  const curl = spawnSync('curl', ['-fL', '--progress-bar', zipUrl, '-o', zipPath], {
    stdio: 'inherit',
  });
  if (curl.status !== 0) fail('download failed');
  log(`extracting to ${root}`);
  const unzip = spawnSync('unzip', ['-q', zipPath, '-d', root], { stdio: 'inherit' });
  fs.rmSync(zipPath, { force: true });
  if (unzip.status !== 0) fail('extract failed');

  app = findApp(root);
  if (!app) fail('Chromium.app not found after extract — snapshot layout unexpected');
  // Strip Gatekeeper quarantine so it launches without prompting.
  spawnSync('xattr', ['-dr', 'com.apple.quarantine', app]);
  return app;
}

function waitForServer(target, timeoutMs = 30_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(target, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error(`server at ${target} never came up`));
        else setTimeout(attempt, 300);
      });
    };
    attempt();
  });
}

const app = await ensureBinary();
if (flags.has('--download-only')) {
  log(`cached at ${app}`);
  process.exit(0);
}

let server = null;
if (!url) {
  if (flags.has('--dev')) {
    log('starting vite dev server (modern ESM — needs chromium >= 63)');
    server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT)], {
      cwd: appRoot,
      stdio: 'inherit',
    });
  } else {
    buildWeb();
    log('starting vite preview (built output incl. legacy chunks)');
    server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(PORT)], {
      cwd: appRoot,
      stdio: 'inherit',
    });
  }
  url = `http://localhost:${PORT}/`;
  await waitForServer(url);
}

const bin = path.join(app, 'Contents', 'MacOS', 'Chromium');
log(`launching Chromium ${version} at ${url}`);
// Force x86_64 via Rosetta — `open -a` sometimes fails to translate these
// bundles automatically ("incorrect executable format").
const chromium = spawn(
  'arch',
  ['-x86_64', bin, `--user-data-dir=${path.join(os.tmpdir(), `everframe-chromium-${version}`)}`, '--no-first-run', url],
  { stdio: 'ignore', detached: !server },
);

if (server) {
  // Stay attached to the preview/dev server; Ctrl-C tears both down.
  const teardown = () => {
    chromium.kill();
    server.kill('SIGINT');
    process.exit(0);
  };
  process.on('SIGINT', teardown);
  process.on('SIGTERM', teardown);
  server.on('exit', (code) => process.exit(code ?? 0));
} else {
  chromium.unref();
}
