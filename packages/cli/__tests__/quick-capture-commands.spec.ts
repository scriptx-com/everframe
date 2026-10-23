// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureCommand, linkCommand } from '../src/quick-capture/commands.js';
import { writeCredentials } from '../src/quick-capture/credentials.js';

const TOKEN = `evf_cap_${'Z'.repeat(32)}`;

function setup(opts: {
  adbDevices?: string;
  sims?: { udid: string; name: string }[];
  failPush?: string[];
  triggerFail?: boolean;
  login?: boolean;
  adb?: boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), 'evf-cmd-home-'));
  if (opts.login !== false) writeCredentials({ token: TOKEN, url: 'u', email: 'e' }, home);
  const sdk = mkdtempSync(join(tmpdir(), 'evf-cmd-sdk-'));
  mkdirSync(join(sdk, 'platform-tools'));
  writeFileSync(join(sdk, 'platform-tools', 'adb'), '');
  chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
  const env = opts.adb === false ? { PATH: '/nonexistent' } : { ANDROID_HOME: sdk, PATH: '' };
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    if (args[0] === 'devices') return { stdout: opts.adbDevices ?? '', stderr: '', code: 0 };
    if (cmd === 'xcrun' && args[1] === 'list') {
      const devices = {
        'com.apple.CoreSimulator.SimRuntime.iOS-18-0': (opts.sims ?? []).map((s) => ({
          ...s,
          state: 'Booted',
        })),
      };
      return { stdout: JSON.stringify(devices ? { devices } : {}), stderr: '', code: 0 };
    }
    if (args.includes('put') && opts.failPush?.includes(args[1] as string))
      return { stdout: '', stderr: `boom ${TOKEN}`, code: 1 };
    if (opts.triggerFail && (args.includes('notifyutil') || args.includes('broadcast')))
      return { stdout: '', stderr: `failed ${TOKEN}`, code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const out: string[] = [];
  const err: string[] = [];
  return {
    calls,
    out,
    err,
    deps: {
      run,
      env,
      home,
      platform: 'darwin' as const,
      out: (s: string) => out.push(s),
      err: (s: string) => err.push(s),
    },
  };
}

const triggers = (calls: [string, string[]][]) =>
  calls.filter(([, a]) => a.includes('notifyutil') || a.includes('broadcast'));

describe('link', () => {
  it('requires login', async () => {
    const t = setup({ login: false });
    expect(await linkCommand(t.deps)).toBe(1);
    expect(t.err).toEqual(['Not logged in. Run npx @everframe/cli login first.']);
  });

  it('exits 0 with a hint when adb or emulators are missing', async () => {
    for (const t of [setup({ adb: false }), setup({ adbDevices: 'List\nR58M123\tdevice\n' })]) {
      expect(await linkCommand(t.deps)).toBe(0);
      expect(t.out).toEqual([
        'No running Android emulators. iOS simulators read your login automatically.',
      ]);
    }
  });

  it('links each emulator; 0 if any succeeded, 1 if all failed', async () => {
    const devs = 'emulator-5554\tdevice\nemulator-5556\tdevice\n';
    const some = setup({ adbDevices: devs, failPush: ['emulator-5556'] });
    expect(await linkCommand(some.deps)).toBe(0);
    expect(some.out).toEqual(['Linked emulator-5554', "Couldn't link emulator-5556"]);
    const none = setup({ adbDevices: devs, failPush: ['emulator-5554', 'emulator-5556'] });
    expect(await linkCommand(none.deps)).toBe(1);
    const all = [...some.out, ...some.err, ...none.out, ...none.err].join('\n');
    expect(all).not.toContain(TOKEN);
  });
});

describe('capture', () => {
  it('reports no targets', async () => {
    const t = setup({ adb: false });
    expect(await captureCommand(t.deps)).toBe(1);
    expect(t.err).toEqual(['No booted simulator or running emulator.']);
  });

  it('fires the only target', async () => {
    const t = setup({ adbDevices: 'emulator-5554\tdevice\n' });
    expect(await captureCommand(t.deps)).toBe(0);
    expect(t.out).toEqual(['Capture sent to emulator-5554.']);
    expect(triggers(t.calls)).toHaveLength(1);
  });

  it('lists several targets, exits 2 and fires nothing', async () => {
    const t = setup({ adbDevices: 'emulator-5554\tdevice\nemulator-5556\tdevice\n' });
    expect(await captureCommand(t.deps)).toBe(2);
    expect(t.out).toEqual([
      'emulator-5554  emulator-5554',
      'emulator-5556  emulator-5556',
      'Pick one with --device <id>.',
    ]);
    expect(triggers(t.calls)).toHaveLength(0);
  });

  it('--device picks by serial', async () => {
    const t = setup({ adbDevices: 'emulator-5554\tdevice\nemulator-5556\tdevice\n' });
    expect(await captureCommand(t.deps, { device: 'emulator-5556' })).toBe(0);
    expect(triggers(t.calls)).toEqual([
      [
        expect.stringContaining('adb'),
        ['-s', 'emulator-5556', 'shell', 'am', 'broadcast', '-a', 'com.everframe.CAPTURE'],
      ],
    ]);
  });

  it('--device with no match fails without firing', async () => {
    const t = setup({ adbDevices: 'emulator-5554\tdevice\n' });
    expect(await captureCommand(t.deps, { device: 'nope' })).toBe(1);
    expect(t.err).toEqual(['No booted simulator or running emulator matches nope.']);
    expect(triggers(t.calls)).toHaveLength(0);
  });

  it('--device matches simulator udid or exact name', async () => {
    const sims = [
      { udid: 'U1', name: 'iPhone 16' },
      { udid: 'U2', name: 'iPad' },
    ];
    for (const device of ['U1', 'iPhone 16']) {
      const t = setup({ sims });
      expect(await captureCommand(t.deps, { device })).toBe(0);
      expect(t.out).toEqual(['Capture sent to iPhone 16.']);
      expect(triggers(t.calls)).toEqual([
        ['xcrun', ['simctl', 'spawn', 'U1', 'notifyutil', '-p', 'com.everframe.capture']],
      ]);
    }
  });

  it('a failing trigger exits 1 with redacted stderr', async () => {
    const t = setup({ adbDevices: 'emulator-5554\tdevice\n', triggerFail: true });
    expect(await captureCommand(t.deps)).toBe(1);
    expect(t.err.join('\n')).toContain('[redacted]');
    expect([...t.out, ...t.err].join('\n')).not.toContain(TOKEN);
  });
});
