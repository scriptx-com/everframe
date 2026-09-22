#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Wraps `expo start` / `expo run:ios` / `expo run:android`. The Metro port
// defaults to 8081 (RN default) and can be overridden with METRO_PORT. If the
// chosen port is taken when this wrapper runs, we exit with a clear error
// rather than allocating a fallback port — Expo CLI is responsible for
// telling the dev build where to fetch the bundle, and any drift between the
// build's expected port and the actual Metro port has historically caused
// tvOS "No script URL provided" failures that are hard to diagnose. To keep
// build and Metro in agreement, the chosen port is forwarded to Expo via
// `--port`. Using the same explicit default everywhere prevents drift.
//
// To run two RN samples concurrently, give this one its own port:
//   METRO_PORT=8082 pnpm ios
//
// Usage (wired in package.json `scripts`):
//   "start":   "node scripts/with-free-port.mjs expo start"
//   "ios":     "node scripts/with-free-port.mjs expo run:ios"
//   "android": "node scripts/with-free-port.mjs expo run:android"

import net from 'node:net';
import { spawn } from 'node:child_process';

const PORT = Number(process.env.METRO_PORT ?? 8081);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[traceitx-example] invalid METRO_PORT: ${process.env.METRO_PORT}`);
  process.exit(2);
}

// Bind without specifying host so we contest the exact same address Metro
// itself binds. macOS BSD permits separate IPv4 and IPv6 listeners on the
// same port; a probe restricted to 127.0.0.1 falsely reports free when
// something is bound on `::` (IPv6 all-interfaces) only — which is the
// default for many Node servers including Metro.
function isFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) {
  console.error('usage: node scripts/with-free-port.mjs <cmd> [...args]');
  process.exit(2);
}

if (!(await isFree(PORT))) {
  console.error(
    `\n[traceitx-example] Metro port ${PORT} is already in use.\n` +
    `Another RN sample is probably running. Stop it, or run this one on\n` +
    `its own port:\n` +
    `  METRO_PORT=8082 pnpm ios\n` +
    `  lsof -nP -iTCP:${PORT} -sTCP:LISTEN     # see what is holding it\n`,
  );
  process.exit(1);
}

console.error(`[traceitx-example] using Metro port ${PORT}`);

// Forward the port to Expo so the dev build's script URL and Metro agree —
// see the drift warning in the header. Skip if the caller already passed one.
const EXPO_PORT_COMMANDS = ['start', 'run:ios', 'run:android'];
const SHOULD_INJECT_PORT_FLAG =
  cmd === 'expo' &&
  args.length > 0 &&
  EXPO_PORT_COMMANDS.includes(args[0]) &&
  !args.includes('--port') &&
  !args.includes('-p');

if (SHOULD_INJECT_PORT_FLAG) {
  args.push('--port', String(PORT));
}

// Default `expo run:ios|android` to interactive-picker mode (-d). Without -d,
// expo picks whatever simulator was last booted, which surprises hosts that
// have phone + TV sims active or that want to target a real device. -d brings
// up Expo's built-in picker; developers can still bypass with --device <NAME>.
const SHOULD_INJECT_DEVICE_FLAG =
  cmd === 'expo' &&
  args.length > 0 &&
  ['run:ios', 'run:android'].includes(args[0]) &&
  !args.includes('-d') &&
  !args.includes('--device');

if (SHOULD_INJECT_DEVICE_FLAG) {
  args.push('-d');
}

// Dev ingest URL for the iOS/tvOS simulator. `expo run:ios` launches the
// app via `simctl launch`, which forwards only host env prefixed with
// SIMCTL_CHILD_ — so mirror TRACEITX_DEV_INGEST_URL (default local ingest)
// into that shape. Only the Debug-built vendored xcframework reads it
// (`#if DEBUG` in IngestEndpoint.swift); against a Release framework or the
// published pod it is inert. Simulators share the host network namespace,
// hence localhost (Android's 10.0.2.2 does not apply here; the Android AAR
// bakes its URL at publish time instead — see scripts/dev/rn.mjs).
const devIngestUrl = process.env.TRACEITX_DEV_INGEST_URL || 'http://localhost:8787';
const env = {
  ...process.env,
  TRACEITX_DEV_INGEST_URL: devIngestUrl,
  SIMCTL_CHILD_TRACEITX_DEV_INGEST_URL:
    process.env.SIMCTL_CHILD_TRACEITX_DEV_INGEST_URL || devIngestUrl,
};

const child = spawn(cmd, args, { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});
