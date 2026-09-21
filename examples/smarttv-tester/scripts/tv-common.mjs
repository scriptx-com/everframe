// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Shared helpers for the Tizen/webOS packagers: run the vite build, stage a
// dist for packaging (full bundle or a thin hosted-URL shell), and small
// process utilities.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function log(msg) {
  console.log(`[smarttv-tester] ${msg}`);
}

export function fail(msg) {
  console.error(`[smarttv-tester] ${msg}`);
  process.exit(1);
}

/** Run a command inheriting stdio; exit non-zero on failure. */
export function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: appRoot, ...opts });
  if (res.error) fail(`${cmd} failed to start: ${res.error.message}`);
  if (res.status !== 0) fail(`${cmd} exited with ${res.status}`);
}

export function buildWeb() {
  run('pnpm', ['exec', 'vite', 'build']);
}

/** First non-internal IPv4 address, for printing LAN URLs. */
export function lanIp() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return '127.0.0.1';
}

/**
 * Assemble the directory handed to the platform packager.
 *
 * Default: copy the vite dist plus the platform manifest/icons — the app is
 * fully self-contained in the .wgt/.ipk.
 *
 * With HOSTED_URL set: skip the local bundle entirely and stage only the
 * manifest, icons, and a stub index.html that redirects to the hosted app
 * (`pnpm run:hosted` or any deployed URL). Install once, then iterate on the
 * web build alone.
 */
export function stageForPackaging(platform, { hostedUrl } = {}) {
  const staging = path.join(appRoot, 'build', platform);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  if (hostedUrl) {
    fs.writeFileSync(
      path.join(staging, 'index.html'),
      [
        '<!DOCTYPE html>',
        '<html><head><meta charset="UTF-8"><title>TraceItX TV Tester</title></head>',
        '<body style="background:#0d0d28">',
        `<script>location.replace(${JSON.stringify(hostedUrl)});</script>`,
        '</body></html>',
        '',
      ].join('\n'),
    );
    log(`staged hosted shell -> ${hostedUrl}`);
  } else {
    const dist = path.join(appRoot, 'dist');
    if (!fs.existsSync(path.join(dist, 'index.html'))) {
      fail('dist/ missing — vite build did not run?');
    }
    fs.cpSync(dist, staging, { recursive: true });
  }

  fs.cpSync(path.join(appRoot, 'platforms', platform), staging, { recursive: true });
  return staging;
}
