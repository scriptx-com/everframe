// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  clearToken,
  defaultRunner,
  findAdb,
  listBootedSimulators,
  listEmulators,
  pushToken,
  triggerEmulator,
  triggerSimulator,
} from '../src/quick-capture/devices.js';

const ok = (stdout = '') => ({ stdout, stderr: '', code: 0 });

function fakeSdk(dirName: string): string {
  const root = mkdtempSync(join(tmpdir(), 'evf-adb-'));
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'adb'), '#!/bin/sh\n');
  chmodSync(join(dir, 'adb'), 0o755);
  return root;
}

describe('findAdb', () => {
  it('prefers ANDROID_HOME, then ANDROID_SDK_ROOT, then PATH', () => {
    const home = fakeSdk('platform-tools');
    const sdk = fakeSdk('platform-tools');
    const onPath = fakeSdk('bin');
    expect(findAdb({ ANDROID_HOME: home, ANDROID_SDK_ROOT: sdk, PATH: join(onPath, 'bin') })).toBe(
      join(home, 'platform-tools', 'adb'),
    );
    expect(findAdb({ ANDROID_HOME: '/nonexistent', ANDROID_SDK_ROOT: sdk })).toBe(
      join(sdk, 'platform-tools', 'adb'),
    );
    expect(findAdb({ PATH: join(onPath, 'bin') })).toBe(join(onPath, 'bin', 'adb'));
    expect(findAdb({ PATH: '/nonexistent' }, 'linux', '/nonexistent')).toBeNull();
  });
});

describe('findAdb platforms', () => {
  const winSdk = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'evf-adb-win-'));
    mkdirSync(join(root, 'platform-tools'), { recursive: true });
    writeFileSync(join(root, 'platform-tools', 'adb.exe'), '');
    chmodSync(join(root, 'platform-tools', 'adb.exe'), 0o755);
    return root;
  };

  it('looks for adb.exe on win32 in the SDK folders and on PATH', () => {
    const sdk = winSdk();
    expect(findAdb({ ANDROID_HOME: sdk }, 'win32', '/nohome')).toBe(
      join(sdk, 'platform-tools', 'adb.exe'),
    );
    expect(findAdb({ ANDROID_SDK_ROOT: sdk }, 'win32', '/nohome')).toBe(
      join(sdk, 'platform-tools', 'adb.exe'),
    );
    const bin = winSdk();
    expect(findAdb({ PATH: join(bin, 'platform-tools') }, 'win32', '/nohome')).toBe(
      join(bin, 'platform-tools', 'adb.exe'),
    );
    // A plain `adb` file is not what Windows runs.
    expect(findAdb({ ANDROID_HOME: fakeSdk('platform-tools') }, 'win32', '/nohome')).toBeNull();
  });

  it('falls back to the default SDK folder per platform', () => {
    const mac = mkdtempSync(join(tmpdir(), 'evf-adb-home-'));
    const macDir = join(mac, 'Library', 'Android', 'sdk', 'platform-tools');
    mkdirSync(macDir, { recursive: true });
    writeFileSync(join(macDir, 'adb'), '');
    chmodSync(join(macDir, 'adb'), 0o755);
    expect(findAdb({ PATH: '/nonexistent' }, 'darwin', mac)).toBe(join(macDir, 'adb'));

    const linux = mkdtempSync(join(tmpdir(), 'evf-adb-home-'));
    const linuxDir = join(linux, 'Android', 'Sdk', 'platform-tools');
    mkdirSync(linuxDir, { recursive: true });
    writeFileSync(join(linuxDir, 'adb'), '');
    chmodSync(join(linuxDir, 'adb'), 0o755);
    expect(findAdb({ PATH: '/nonexistent' }, 'linux', linux)).toBe(join(linuxDir, 'adb'));

    const local = mkdtempSync(join(tmpdir(), 'evf-adb-local-'));
    const winDir = join(local, 'Android', 'Sdk', 'platform-tools');
    mkdirSync(winDir, { recursive: true });
    writeFileSync(join(winDir, 'adb.exe'), '');
    chmodSync(join(winDir, 'adb.exe'), 0o755);
    expect(findAdb({ LOCALAPPDATA: local, PATH: '' }, 'win32', '/nohome')).toBe(
      join(winDir, 'adb.exe'),
    );
    expect(findAdb({ PATH: '' }, 'win32', '/nohome')).toBeNull();
  });
});

describe('listEmulators', () => {
  it('keeps only emulator serials in state device', async () => {
    const run = vi.fn(async () =>
      ok(
        'List of devices attached\nemulator-5554\tdevice\nemulator-5556\toffline\nR58M123\tdevice\n\n',
      ),
    );
    expect(await listEmulators(run, '/x/adb')).toEqual(['emulator-5554']);
    expect(run).toHaveBeenCalledWith('/x/adb', ['devices']);
  });

  it('is empty when adb fails', async () => {
    expect(await listEmulators(async () => ({ stdout: '', stderr: 'x', code: 1 }), 'adb')).toEqual(
      [],
    );
  });
});

describe('listBootedSimulators', () => {
  it('parses simctl JSON', async () => {
    const run = vi.fn(async () =>
      ok(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              { udid: 'U1', name: 'iPhone 16', state: 'Booted' },
            ],
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [],
          },
        }),
      ),
    );
    const sims = await listBootedSimulators(run, 'darwin');
    expect(sims).toEqual([{ udid: 'U1', name: 'iPhone 16' }]);
    expect(run).toHaveBeenCalledWith('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  });

  it('lists iOS simulators only, not tvOS or watchOS', async () => {
    const run = vi.fn(async () =>
      ok(
        JSON.stringify({
          devices: {
            'com.apple.CoreSimulator.SimRuntime.iOS-18-0': [
              { udid: 'U1', name: 'iPhone 16', state: 'Booted' },
            ],
            'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [
              { udid: 'U2', name: 'Apple TV', state: 'Booted' },
            ],
            'com.apple.CoreSimulator.SimRuntime.watchOS-11-0': [
              { udid: 'U3', name: 'Watch', state: 'Booted' },
            ],
          },
        }),
      ),
    );
    expect(await listBootedSimulators(run, 'darwin')).toEqual([{ udid: 'U1', name: 'iPhone 16' }]);
  });

  it('is empty off macOS without running xcrun', async () => {
    const run = vi.fn(async () => ok('{}'));
    expect(await listBootedSimulators(run, 'linux')).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it('is empty when xcrun fails or prints junk', async () => {
    expect(
      await listBootedSimulators(async () => ({ stdout: '', stderr: '', code: 1 }), 'darwin'),
    ).toEqual([]);
    expect(await listBootedSimulators(async () => ok('not json'), 'darwin')).toEqual([]);
  });
});

describe('device commands', () => {
  it('uses exact argument arrays', async () => {
    const run = vi.fn(async () => ok());
    await pushToken(run, 'adb', 'emulator-5554', 'TOK');
    await clearToken(run, 'adb', 'emulator-5554');
    await triggerSimulator(run, 'U1');
    await triggerEmulator(run, 'adb', 'emulator-5554');
    expect(run.mock.calls).toEqual([
      [
        'adb',
        ['-s', 'emulator-5554', 'shell', 'settings', 'put', 'global', 'everframe_token', 'TOK'],
      ],
      ['adb', ['-s', 'emulator-5554', 'shell', 'settings', 'delete', 'global', 'everframe_token']],
      ['xcrun', ['simctl', 'spawn', 'U1', 'notifyutil', '-p', 'com.everframe.capture']],
      ['adb', ['-s', 'emulator-5554', 'shell', 'am', 'broadcast', '-a', 'com.everframe.CAPTURE']],
    ]);
  });
});

describe('defaultRunner', () => {
  it('never surfaces the command line (and so a token) on failure', async () => {
    const token = `evf_cap_${'Q'.repeat(32)}`;
    const failed = await defaultRunner(process.execPath, ['-e', 'process.exit(3)', token]);
    expect(failed.code).toBe(3);
    const missing = await defaultRunner('/nonexistent/evf-adb', ['put', token]);
    expect(missing.code).not.toBe(0);
    expect(JSON.stringify([failed, missing])).not.toContain(token);
    expect(missing.stderr).toBe("Couldn't run evf-adb");
  });
});
