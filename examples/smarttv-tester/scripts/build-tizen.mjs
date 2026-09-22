// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Package the tester as a Samsung Tizen .wgt, optionally install + launch it
// on a device/emulator.
//
//   pnpm build:tizen                        # build + package -> build/output/*.wgt
//   DEVICE=<serial> pnpm run:tizen          # + install & launch on the device
//   HOSTED_URL=http://<lan-ip>:4174 pnpm build:tizen   # thin shell that loads the hosted app
//
// Env:
//   TIZEN_CERT_NAME  security profile name from Tizen Studio's certificate
//                    manager (required for packaging)
//   TIZEN_CLI        path to the tizen CLI (default: `tizen` on PATH, then
//                    ~/tizen-studio/tools/ide/bin/tizen)
//   DEVICE           target from `sdb devices` (implies install; --run launches too)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { appRoot, buildWeb, fail, log, run, stageForPackaging } from './tv-common.mjs';

const APP_ID = 'TrCiTxTstr.TraceItXTester';
const shouldRun = process.argv.includes('--run');

function findTizenCli() {
  if (process.env.TIZEN_CLI) return process.env.TIZEN_CLI;
  const onPath = spawnSync('which', ['tizen'], { encoding: 'utf8' });
  if (onPath.status === 0) return onPath.stdout.trim();
  const fallback = path.join(os.homedir(), 'tizen-studio', 'tools', 'ide', 'bin', 'tizen');
  if (fs.existsSync(fallback)) return fallback;
  fail('tizen CLI not found — install Tizen Studio or set TIZEN_CLI');
}

const tizen = findTizenCli();
const certName = process.env.TIZEN_CERT_NAME;
if (!certName) {
  fail('TIZEN_CERT_NAME is required (a security profile from Tizen Studio certificate manager)');
}

const hostedUrl = process.env.HOSTED_URL;
if (!hostedUrl) buildWeb();
const staging = stageForPackaging('tizen', { hostedUrl });

const outDir = path.join(appRoot, 'build', 'output');
fs.mkdirSync(outDir, { recursive: true });
run(tizen, ['package', '--', staging, '-s', certName, '-t', 'wgt', '-o', outDir]);

const wgt = fs.readdirSync(outDir).find((f) => f.endsWith('.wgt'));
if (!wgt) fail('packaging produced no .wgt');
log(`packaged ${path.join('build', 'output', wgt)}`);

const device = process.env.DEVICE;
if (device) {
  // Uninstall first so repeated installs don't fail on signature mismatch.
  spawnSync(tizen, ['uninstall', '-p', APP_ID, '-t', device], { stdio: 'inherit' });
  run(tizen, ['install', '--', outDir, '-n', wgt, '-t', device]);
  if (shouldRun) run(tizen, ['run', '-p', APP_ID, '-t', device]);
} else if (shouldRun) {
  fail('--run needs DEVICE=<target from `sdb devices`>');
} else {
  log('set DEVICE=<serial> to install on a TV/emulator');
}
