// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  clearToken,
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
    expect(findAdb({ PATH: '/nonexistent' })).toBeNull();
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
    const sims = await listBootedSimulators(run);
    if (process.platform === 'darwin') {
      expect(sims).toEqual([{ udid: 'U1', name: 'iPhone 16' }]);
      expect(run).toHaveBeenCalledWith('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
    } else {
      expect(sims).toEqual([]);
    }
  });

  it('is empty when xcrun fails or prints junk', async () => {
    expect(await listBootedSimulators(async () => ({ stdout: '', stderr: '', code: 1 }))).toEqual(
      [],
    );
    expect(await listBootedSimulators(async () => ok('not json'))).toEqual([]);
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
      ['adb', ['-s', 'emulator-5554', 'shell', 'settings', 'put', 'global', 'everframe_token', 'TOK']],
      ['adb', ['-s', 'emulator-5554', 'shell', 'settings', 'delete', 'global', 'everframe_token']],
      ['xcrun', ['simctl', 'spawn', 'U1', 'notifyutil', '-p', 'com.everframe.capture']],
      ['adb', ['-s', 'emulator-5554', 'shell', 'am', 'broadcast', '-a', 'com.everframe.CAPTURE']],
    ]);
  });
});
