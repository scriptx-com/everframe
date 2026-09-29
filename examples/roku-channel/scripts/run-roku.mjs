#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Build, instrument and sideload the Roku crash lab.
//   node scripts/run-roku.mjs [--no-deploy] [--no-instrument] [--remote-library <https-url>] [--logs]
// Config comes from the repo-root .env (override path with EVERFRAME_ENV_FILE);
// process env wins over the file.
import { spawnSync } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs as nodeParseArgs } from 'node:util';

const EXAMPLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(EXAMPLE, '../..');
const SDK = path.join(REPO, 'packages/sdk-roku');
const BUILD = path.join(EXAMPLE, '.build');
const ZIP_NAME = 'everframe-crash-lab.zip';

export function parseArgs(argv) {
  const { values } = nodeParseArgs({
    args: argv,
    options: {
      'no-deploy': { type: 'boolean', default: false },
      'no-instrument': { type: 'boolean', default: false },
      'remote-library': { type: 'string' },
      logs: { type: 'boolean', default: false },
    },
  });
  if (values['remote-library'] && !/^https?:\/\//.test(values['remote-library'])) {
    throw new Error('--remote-library must be an http(s) URL');
  }
  return values;
}

// Quoted values keep everything between the PAIRED quotes (including '#');
// unquoted values lose a trailing " # comment" and surrounding whitespace.
function parseValue(raw) {
  const v = raw.trim();
  const q = v.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
  if (q) return q[2];
  return v.replace(/\s+#.*$/, '').trim();
}

export function loadEnv(processEnv = process.env) {
  const file = processEnv.EVERFRAME_ENV_FILE || path.join(REPO, '.env');
  const fromFile = {};
  if (file !== '/dev/null' && existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
      if (m) fromFile[m[1]] = parseValue(m[2]);
    }
  }
  const pick = (k) => (processEnv[k] !== undefined ? processEnv[k] : fromFile[k]) ?? '';
  return {
    key: pick('EVERFRAME_KEY_ROKU'),
    endpoint: pick('EVERFRAME_INGEST_URL'),
    host: pick('ROKU_HOST'),
    password: pick('ROKU_DEV_PASSWORD'),
  };
}

const brsString = (s) => '"' + String(s).replace(/"/g, '""') + '"';

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) {
    if (r.error.code === 'ENOENT') throw new Error(`${cmd} not found on PATH - install pnpm 9 (corepack enable)`);
    throw r.error;
  }
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}`);
}

export function ingestWarning(endpoint) {
  if (!endpoint) return null;
  let host;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    try {
      host = new URL(`http://${endpoint}`).hostname;
    } catch {
      host = '';
    }
  }
  const local = host ? /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/i.test(host) : /localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]/.test(endpoint);
  return local ? `[crash-lab] WARNING: EVERFRAME_INGEST_URL=${endpoint} points at localhost - the TV cannot reach it. Use your machine's LAN IP.` : null;
}

// Streams the Roku debug console (telnet 8085) into a file, retrying while the
// channel is still starting. `done` resolves when the socket closes and rejects
// if no connection could be made within timeoutMs. `close()` stops everything.
export function streamLogs(host, { port = 8085, logFile = path.join(BUILD, 'console.log'), retryMs = 1000, timeoutMs = 15000, attemptMs = 3000, quiet = false } = {}) {
  mkdirSync(path.dirname(logFile), { recursive: true });
  const out = createWriteStream(logFile);
  const started = Date.now();
  let sock;
  let timer;
  let closed = false;
  let settle;
  const done = new Promise((resolve, reject) => (settle = { resolve, reject }));
  done.catch(() => {});

  let connectedOnce = false;
  // Overall connect budget: a blackholed host (SYNs dropped) must not outlive it.
  const deadline = setTimeout(() => {
    if (!connectedOnce) finish(new Error(`could not connect to ${host}:${port} within ${timeoutMs / 1000}s`));
  }, timeoutMs);
  const finish = (err) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(deadline);
    sock?.destroy();
    out.end(() => (err ? settle.reject(err) : settle.resolve()));
  };
  const attempt = () => {
    sock = net.connect(port, host);
    let connected = false;
    sock.setTimeout(Math.max(1, Math.min(attemptMs, timeoutMs - (Date.now() - started))), () => {
      if (!connected) sock.destroy(); // 'close' follows and drives the retry / deadline
    });
    sock.on('connect', () => {
      connected = true;
      connectedOnce = true;
      sock.setTimeout(0);
      if (!quiet) console.log(`[crash-lab] connected to ${host}:${port}`);
    });
    sock.on('data', (d) => {
      if (!quiet) process.stdout.write(d);
      out.write(d);
    });
    sock.on('close', () => {
      if (closed) return;
      if (connected) return finish();
      if (Date.now() - started >= timeoutMs) return finish(new Error(`could not connect to ${host}:${port} within ${timeoutMs / 1000}s`));
      timer = setTimeout(attempt, retryMs);
    });
    sock.on('error', () => {}); // 'close' follows and drives the retry
  };
  if (!quiet) console.log(`[crash-lab] streaming ${host}:${port} -> ${path.relative(EXAMPLE, logFile)} (Ctrl+C to stop)`);
  attempt();
  return { done, close: () => finish() };
}

export async function main(argv = process.argv.slice(2), processEnv = process.env) {
  const args = parseArgs(argv);
  const env = loadEnv(processEnv);
  if (!env.key) throw new Error('EVERFRAME_KEY_ROKU is not set (root .env or environment)');
  if (!args['no-deploy'] && (!env.host || !env.password)) {
    throw new Error('ROKU_HOST and ROKU_DEV_PASSWORD are required to deploy (or pass --no-deploy)');
  }
  const warning = ingestWarning(env.endpoint);
  if (warning) console.warn(warning);

  run('pnpm', ['--filter', '@everframe/roku', 'build'], REPO);
  const sdkVersion = JSON.parse(readFileSync(path.join(SDK, 'package.json'), 'utf8')).version;
  const libZip = `everframe-roku-${sdkVersion}.zip`;
  const libraryUri = args['remote-library'] ?? `pkg:/components/${libZip}`;

  rmSync(BUILD, { recursive: true, force: true });
  const src = path.join(BUILD, 'src');
  const out = path.join(BUILD, 'out');
  mkdirSync(BUILD, { recursive: true });
  for (const part of ['manifest', 'source', 'components']) cpSync(path.join(EXAMPLE, part), path.join(src, part), { recursive: true });
  mkdirSync(path.join(src, 'components/generated'), { recursive: true });
  writeFileSync(
    path.join(src, 'components/generated/ef_config.brs'),
    [
      "' Generated by scripts/run-roku.mjs from .env - do not commit.",
      'function EfExample_Config() as object',
      `    return { sdkKey: ${brsString(env.key)}, endpoint: ${brsString(env.endpoint)}, libraryUri: ${brsString(libraryUri)} }`,
      'end function',
      '',
    ].join('\n'),
  );

  const bundle = !args['remote-library'];
  if (args['no-instrument']) {
    cpSync(src, out, { recursive: true });
    if (bundle) cpSync(path.join(SDK, 'dist', libZip), path.join(out, 'components', libZip));
  } else {
    const cli = ['exec', 'everframe-roku', 'instrument', src, '--out', out, '--exclude', 'components/Excluded.brs', '--exclude', 'components/OomTask.brs'];
    if (bundle) cli.push('--bundle-library');
    run('pnpm', cli, EXAMPLE);
  }

  const rokuDeploy = await import('roku-deploy');
  await rokuDeploy.createPackage({ rootDir: out, outDir: BUILD, outFile: ZIP_NAME, retainStagingDir: false });
  console.log(`[crash-lab] packaged ${path.relative(EXAMPLE, path.join(BUILD, ZIP_NAME))} (library: ${libraryUri})`);

  if (args['no-deploy']) return;
  try {
    await rokuDeploy.publish({ host: env.host, password: env.password, rootDir: out, outDir: BUILD, outFile: ZIP_NAME });
  } catch (e) {
    throw new Error(`${e.message} (check ROKU_HOST, ROKU_DEV_PASSWORD and that developer mode is enabled)`, { cause: e });
  }
  console.log(`[crash-lab] sideloaded to ${env.host}`);
  if (args.logs) {
    const handle = streamLogs(env.host);
    process.once('SIGINT', () => {
      handle.close();
      handle.done.finally(() => process.exit(0));
    });
    await handle.done;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
