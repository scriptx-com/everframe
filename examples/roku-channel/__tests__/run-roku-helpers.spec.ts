// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
// @ts-expect-error plain .mjs module without types
import { loadEnv, streamLogs, ingestWarning, parseArgs } from '../scripts/run-roku.mjs';

function envFrom(text: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'roku-env-'));
  const file = path.join(dir, '.env');
  writeFileSync(file, text);
  return loadEnv({ EVERFRAME_ENV_FILE: file });
}

describe('loadEnv parsing', () => {
  it('trims trailing whitespace and accepts an export prefix', () => {
    const e = envFrom('export EVERFRAME_KEY_ROKU=abc123   \t\nexport   ROKU_HOST = 10.0.0.5  \n');
    expect(e.key).toBe('abc123');
    expect(e.host).toBe('10.0.0.5');
  });

  it('strips inline comments from unquoted values only', () => {
    const e = envFrom('EVERFRAME_KEY_ROKU=abc # my key\nROKU_HOST="10.0.0.5 # not a comment"\nROKU_DEV_PASSWORD=pa#ss\n');
    expect(e.key).toBe('abc');
    expect(e.host).toBe('10.0.0.5 # not a comment');
    expect(e.password).toBe('pa#ss');
  });

  it('strips only paired quotes and keeps = inside values', () => {
    const e = envFrom("EVERFRAME_KEY_ROKU='abc'  # c\nROKU_HOST=\"oops\nROKU_DEV_PASSWORD=a=b==\nEVERFRAME_INGEST_URL=http://x/?a=1\n");
    expect(e.key).toBe('abc');
    expect(e.host).toBe('"oops');
    expect(e.password).toBe('a=b==');
    expect(e.endpoint).toBe('http://x/?a=1');
  });
});

describe('ingestWarning', () => {
  it.each(['http://localhost:8787', 'http://127.0.0.1:8787', 'http://0.0.0.0:8787', 'http://[::1]:8787', 'localhost:8787'])('warns for %s', (u) => {
    expect(ingestWarning(u)).toMatch(/TV cannot reach/);
  });
  it.each(['', 'http://192.168.1.20:8787', 'https://ingest.example.com/localhost'])('is silent for %s', (u) => {
    expect(ingestWarning(u)).toBeNull();
  });
});

describe('streamLogs', () => {
  it('retries until the console port opens, then writes to the log file', async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const logFile = path.join(mkdtempSync(path.join(tmpdir(), 'roku-log-')), 'console.log');
    const handle = streamLogs('127.0.0.1', { port, logFile, retryMs: 50, timeoutMs: 5000, quiet: true });
    const server = net.createServer((s) => s.end('hello crash\n'));
    await new Promise((r) => setTimeout(r, 300));
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
    await handle.done;
    server.close();
    expect(readFileSync(logFile, 'utf8')).toBe('hello crash\n');
  });

  it('gives up after the timeout', async () => {
    const logFile = path.join(mkdtempSync(path.join(tmpdir(), 'roku-log-')), 'console.log');
    const handle = streamLogs('127.0.0.1', { port: 1, logFile, retryMs: 20, timeoutMs: 150, quiet: true });
    await expect(handle.done).rejects.toThrow(/could not connect/i);
  });

  it('enforces the overall deadline against a blackholed host', async () => {
    const logFile = path.join(mkdtempSync(path.join(tmpdir(), 'roku-log-')), 'console.log');
    const t0 = Date.now();
    // 10.255.255.1 is non-routable: SYNs are dropped, so connect never completes on its own.
    const handle = streamLogs('10.255.255.1', { port: 8085, logFile, retryMs: 20, timeoutMs: 400, quiet: true });
    await expect(handle.done).rejects.toThrow(/could not connect/i);
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe('parseArgs', () => {
  it("accepts pnpm's literal -- separator", () => {
    expect(parseArgs(['--', '--logs']).logs).toBe(true);
    expect(parseArgs(['--logs', '--', '--no-deploy'])).toMatchObject({ logs: true, 'no-deploy': true });
  });

  it('still rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow();
  });
});
