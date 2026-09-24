// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Package the tester as an LG webOS .ipk, optionally install + launch it on
// a device/emulator registered with ares-setup-device.
//
//   pnpm build:webos                        # build + package -> build/output/*.ipk
//   DEVICE=<name> pnpm run:webos            # + ares-install & ares-launch
//   HOSTED_URL=http://<lan-ip>:4174 pnpm build:webos   # thin shell that loads the hosted app
//
// Requires the webOS TV CLI (ares-*) on PATH:
//   https://webostv.developer.lge.com/develop/tools/cli-installation
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appRoot, buildWeb, fail, log, run, stageForPackaging } from './tv-common.mjs';

const APP_ID = 'com.everframe.smarttv.tester';
const shouldRun = process.argv.includes('--run');

if (spawnSync('which', ['ares-package'], { encoding: 'utf8' }).status !== 0) {
  fail('ares-package not found — install the webOS TV CLI and add it to PATH');
}

const hostedUrl = process.env.HOSTED_URL;
if (!hostedUrl) buildWeb();
const staging = stageForPackaging('webos', { hostedUrl });

const outDir = path.join(appRoot, 'build', 'output');
fs.mkdirSync(outDir, { recursive: true });
run('ares-package', ['-o', outDir, staging, '-n']);

const ipk = fs.readdirSync(outDir).find((f) => f.endsWith('.ipk'));
if (!ipk) fail('packaging produced no .ipk');
log(`packaged ${path.join('build', 'output', ipk)}`);

const device = process.env.DEVICE;
if (device) {
  run('ares-install', ['--device', device, path.join(outDir, ipk)]);
  if (shouldRun) run('ares-launch', ['--device', device, APP_ID]);
} else if (shouldRun) {
  fail('--run needs DEVICE=<name from `ares-setup-device --list`>');
} else {
  log('set DEVICE=<name> to install on a TV/emulator');
}
