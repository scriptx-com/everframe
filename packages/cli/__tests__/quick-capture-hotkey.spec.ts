// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type HelperProcess,
  ensureHelper,
  formatHotkey,
  helperBinaryPath,
  helperHash,
  hotkeyCommand,
  parseHotkey,
  serialForPid,
} from '../src/quick-capture/hotkey.js';

const QEMU = '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64';

describe('parseHotkey', () => {
  it('parses the default and symbol spellings to Carbon key codes and modifier bits', () => {
    expect(parseHotkey('Cmd+Shift+B')).toEqual({ keyCode: 11, modifiers: 256 + 512 });
    expect(parseHotkey('⌘+⇧+b')).toEqual({ keyCode: 11, modifiers: 768 });
    expect(parseHotkey('command+SHIFT+B')).toEqual({ keyCode: 11, modifiers: 768 });
    expect(parseHotkey('Ctrl+Alt+5')).toEqual({ keyCode: 0x17, modifiers: 4096 + 2048 });
    expect(parseHotkey('control+opt+shift+F12')).toEqual({
      keyCode: 0x6f,
      modifiers: 4096 + 2048 + 512,
    });
    expect(parseHotkey('⌃+⌥+A')).toEqual({ keyCode: 0, modifiers: 4096 + 2048 });
    expect(parseHotkey('Option+F1')).toEqual({ keyCode: 0x7a, modifiers: 2048 });
    expect(parseHotkey('Cmd+0')).toEqual({ keyCode: 0x1d, modifiers: 256 });
  });

  it('rejects combos without Cmd, Ctrl or Alt, without a key, or with two keys', () => {
    for (const bad of [
      'Shift+B',
      'B',
      'F12',
      'Cmd+Shift',
      'Cmd+A+B',
      'Cmd+Space',
      'Cmd+F13',
      '',
      'Cmd++B',
    ]) {
      expect(() => parseHotkey(bad), bad).toThrow(/Cmd\+Shift\+B/);
    }
  });

  it('formats the combo with macOS symbols', () => {
    expect(formatHotkey(parseHotkey('Cmd+Shift+B'))).toBe('⌘⇧B');
    expect(formatHotkey(parseHotkey('Ctrl+Alt+5'))).toBe('⌃⌥5');
    expect(formatHotkey(parseHotkey('shift+ctrl+cmd+alt+f12'))).toBe('⌘⌃⌥⇧F12');
  });
});

function fakeRun(opts: { psCommand?: string; devices?: string; names?: Record<string, string> }) {
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    if (cmd === 'ps')
      return { stdout: opts.psCommand ?? '', stderr: '', code: opts.psCommand ? 0 : 1 };
    if (args[0] === 'devices') return { stdout: opts.devices ?? '', stderr: '', code: 0 };
    if (args[2] === 'emu' && args[3] === 'avd' && args[4] === 'name') {
      const name = opts.names?.[args[1] as string];
      return name === undefined
        ? { stdout: '', stderr: 'error', code: 1 }
        : { stdout: `${name}\r\nOK\r\n`, stderr: '', code: 0 };
    }
    return { stdout: '', stderr: '', code: 0 };
  };
  return { run, calls };
}

describe('serialForPid', () => {
  const devices = 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n';
  const names = { 'emulator-5554': 'Pixel_8', 'emulator-5556': 'Medium_Phone_API_35' };

  it('matches the AVD from -avd to the emulator reporting the same name', async () => {
    const f = fakeRun({
      psCommand: `${QEMU} -netdelay none -avd Medium_Phone_API_35 -qt-hide-window\n`,
      devices,
      names,
    });
    expect(await serialForPid(f.run, '/sdk/adb', 4242)).toBe('emulator-5556');
    expect(f.calls[0]).toEqual(['ps', ['-o', 'command=', '-p', '4242']]);
    expect(f.calls).toContainEqual(['/sdk/adb', ['-s', 'emulator-5556', 'emu', 'avd', 'name']]);
  });

  it('accepts the @AVD form the emulator launcher also uses', async () => {
    const f = fakeRun({ psCommand: `${QEMU} @Pixel_8\n`, devices, names });
    expect(await serialForPid(f.run, '/sdk/adb', 1)).toBe('emulator-5554');
  });

  it('returns null when no running emulator reports that AVD', async () => {
    const f = fakeRun({ psCommand: `${QEMU} -avd Tablet_API_34\n`, devices, names });
    expect(await serialForPid(f.run, '/sdk/adb', 1)).toBeNull();
  });

  it('returns null when the process has no AVD argument or is gone', async () => {
    expect(
      await serialForPid(
        fakeRun({ psCommand: `${QEMU} -help\n`, devices, names }).run,
        '/sdk/adb',
        1,
      ),
    ).toBeNull();
    expect(await serialForPid(fakeRun({ devices, names }).run, '/sdk/adb', 1)).toBeNull();
  });
});

describe('helper cache', () => {
  it('names the binary after a hash of the source and the compiler version', () => {
    const a = helperHash('source a', 'swift 6.4');
    const b = helperHash('source b', 'swift 6.4');
    const c = helperHash('source a', 'swift 6.5');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set([a, b, c]).size).toBe(3);
    const home = '/Users/x';
    expect(helperBinaryPath(home, a)).toBe(
      join(home, '.everframe', 'bin', `hotkey-${a.slice(0, 12)}`),
    );
    expect(helperBinaryPath(home, a)).not.toBe(helperBinaryPath(home, b));
  });

  function compileSetup(opts: { swiftc?: boolean; compileFails?: boolean } = {}) {
    const home = mkdtempSync(join(tmpdir(), 'evf-hotkey-home-'));
    const dir = mkdtempSync(join(tmpdir(), 'evf-hotkey-src-'));
    const source = join(dir, 'hotkey-macos.swift');
    writeFileSync(source, 'print("hi")\n');
    const calls: [string, string[]][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, args]);
      if (args[1] === '--version')
        return opts.swiftc === false
          ? { stdout: '', stderr: 'xcrun: error: unable to find utility "swiftc"', code: 72 }
          : { stdout: '', stderr: 'Apple Swift version 6.4\n', code: 0 };
      if (args.includes('-o')) {
        if (opts.compileFails)
          return { stdout: '', stderr: 'hotkey-macos.swift:1: error: boom\n', code: 1 };
        const out = args[args.indexOf('-o') + 1] as string;
        writeFileSync(out, '#!/bin/sh\n');
        return { stdout: '', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    return { home, source, run, calls };
  }

  it('compiles into ~/.everframe/bin once and then reuses the binary', async () => {
    const t = compileSetup();
    const first = await ensureHelper({ run: t.run, home: t.home, source: t.source });
    expect('path' in first && first.path).toMatch(
      new RegExp(`^${join(t.home, '.everframe', 'bin')}/hotkey-[0-9a-f]{12}$`),
    );
    const path = (first as { path: string }).path;
    expect(existsSync(path)).toBe(true);
    const compile = t.calls.find(([, a]) => a.includes('-o'));
    expect(compile?.[0]).toBe('xcrun');
    expect(compile?.[1].slice(0, 3)).toEqual(['swiftc', '-O', '-o']);
    expect(compile?.[1][3]).not.toBe(path);
    expect(compile?.[1][4]).toBe(t.source);
    t.calls.length = 0;
    expect(await ensureHelper({ run: t.run, home: t.home, source: t.source })).toEqual({ path });
    expect(t.calls.some(([, a]) => a.includes('-o'))).toBe(false);
  });

  it('reports a missing compiler and a failed build', async () => {
    const none = compileSetup({ swiftc: false });
    expect(await ensureHelper({ run: none.run, home: none.home, source: none.source })).toEqual({
      error: 'no-swiftc',
    });
    const broken = compileSetup({ compileFails: true });
    const result = await ensureHelper({
      run: broken.run,
      home: broken.home,
      source: broken.source,
    });
    expect(result).toMatchObject({ error: 'compile-failed' });
  });
});

class FakeHelper extends EventEmitter implements HelperProcess {
  stdout = new EventEmitter();
  killed: (NodeJS.Signals | number | undefined)[] = [];
  kill(signal?: NodeJS.Signals | number) {
    this.killed.push(signal);
    queueMicrotask(() => this.emit('close', null, signal ?? 'SIGTERM'));
    return true;
  }
  send(event: object) {
    this.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`));
  }
}

function commandSetup(
  opts: { platform?: NodeJS.Platform; swiftc?: boolean; triggerFails?: boolean } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'evf-hotkey-cmd-'));
  const sdk = mkdtempSync(join(tmpdir(), 'evf-hotkey-sdk-'));
  mkdirSync(join(sdk, 'platform-tools'));
  writeFileSync(join(sdk, 'platform-tools', 'adb'), '');
  chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
  const adb = join(sdk, 'platform-tools', 'adb');
  const calls: [string, string[]][] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, args]);
    if (cmd === 'ps') {
      const pid = args[3];
      return pid === '77'
        ? { stdout: `${QEMU} -avd Medium_Phone_API_35\n`, stderr: '', code: 0 }
        : { stdout: `${QEMU} -avd Unknown_AVD\n`, stderr: '', code: 0 };
    }
    if (args[0] === 'devices')
      return { stdout: 'emulator-5554\tdevice\nemulator-5556\tdevice\n', stderr: '', code: 0 };
    if (args[2] === 'emu') {
      const name = args[1] === 'emulator-5556' ? 'Medium_Phone_API_35' : 'Pixel_8';
      return { stdout: `${name}\nOK\n`, stderr: '', code: 0 };
    }
    if (args.includes('broadcast'))
      return opts.triggerFails
        ? { stdout: '', stderr: 'error: closed', code: 1 }
        : { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  const helper = new FakeHelper();
  const spawned: [string, string[]][] = [];
  const signals = new EventEmitter();
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    run,
    env: { ANDROID_HOME: sdk, PATH: '' },
    home,
    platform: opts.platform ?? ('darwin' as NodeJS.Platform),
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
    ensure: async () =>
      opts.swiftc === false
        ? { error: 'no-swiftc' as const }
        : { path: '/home/.everframe/bin/hotkey-abc' },
    spawnHelper: (path: string, args: string[]) => {
      spawned.push([path, args]);
      return helper;
    },
    signals,
  };
  return { deps, helper, spawned, signals, out, err, calls, adb };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

describe('hotkeyCommand', () => {
  it('refuses to run off macOS with a pointer to the capture command', async () => {
    const t = commandSetup({ platform: 'linux' });
    expect(await hotkeyCommand(t.deps)).toBe(1);
    expect(t.err).toEqual([
      'The hotkey helper runs on macOS. On Windows and Linux, bind "npx @everframe/cli capture" to a keyboard shortcut in your desktop settings.',
    ]);
    expect(t.spawned).toEqual([]);
  });

  it('asks for the Command Line Tools when swiftc is missing', async () => {
    const t = commandSetup({ swiftc: false });
    expect(await hotkeyCommand(t.deps)).toBe(1);
    expect(t.err).toEqual([
      'The hotkey helper needs the Xcode Command Line Tools: xcode-select --install',
    ]);
  });

  it('rejects an invalid --key before building anything', async () => {
    const t = commandSetup();
    expect(await hotkeyCommand(t.deps, { key: 'Shift+B' })).toBe(1);
    expect(t.err[0]).toMatch(/Cmd\+Shift\+B/);
    expect(t.spawned).toEqual([]);
  });

  it('spawns the helper, triggers the matched emulator on pressed, and exits 0 on Ctrl+C', async () => {
    const t = commandSetup();
    const done = hotkeyCommand(t.deps);
    await flush();
    expect(t.spawned).toEqual([
      ['/home/.everframe/bin/hotkey-abc', ['--keycode', '11', '--modifiers', '768']],
    ]);
    t.helper.send({ event: 'ready' });
    await flush();
    expect(t.out[0]).toBe(
      'Press ⌘⇧B with an Android emulator window in front to capture it. Ctrl+C to stop.',
    );
    expect(t.out.join('\n')).toContain('Launch in the Running Devices tool window');
    expect(t.out.join('\n')).toContain('npx @everframe/cli capture');
    t.helper.send({ event: 'armed', pid: 77 });
    t.helper.send({ event: 'pressed', pid: 77 });
    await flush();
    const triggers = t.calls.filter(([, a]) => a.includes('broadcast'));
    expect(triggers).toEqual([
      [t.adb, ['-s', 'emulator-5556', 'shell', 'am', 'broadcast', '-a', 'com.everframe.CAPTURE']],
    ]);
    expect(t.out).toContain('Capture sent to emulator-5556.');
    t.signals.emit('SIGINT');
    expect(await done).toBe(0);
    expect(t.helper.killed.length).toBe(1);
    expect(t.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('uses the --key combo for the helper and the prompt', async () => {
    const t = commandSetup();
    const done = hotkeyCommand(t.deps, { key: 'Ctrl+Alt+5' });
    await flush();
    expect(t.spawned[0]?.[1]).toEqual(['--keycode', '23', '--modifiers', String(4096 + 2048)]);
    t.helper.send({ event: 'ready' });
    await flush();
    expect(t.out[0]).toBe(
      'Press ⌃⌥5 with an Android emulator window in front to capture it. Ctrl+C to stop.',
    );
    t.signals.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('says so when the front emulator cannot be matched, and keeps running', async () => {
    const t = commandSetup();
    const done = hotkeyCommand(t.deps);
    await flush();
    t.helper.send({ event: 'pressed', pid: 99 });
    await flush();
    expect(t.err).toContain("Couldn't match the front emulator window to a running emulator.");
    expect(t.calls.some(([, a]) => a.includes('broadcast'))).toBe(false);
    t.signals.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('reports a failed trigger without exiting', async () => {
    const t = commandSetup({ triggerFails: true });
    const done = hotkeyCommand(t.deps);
    await flush();
    t.helper.send({ event: 'pressed', pid: 77 });
    await flush();
    expect(t.err).toEqual(['error: closed']);
    t.signals.emit('SIGINT');
    expect(await done).toBe(0);
  });

  it('exits 1 with the helper message on an error event', async () => {
    const t = commandSetup();
    const done = hotkeyCommand(t.deps);
    await flush();
    t.helper.send({ event: 'ready' });
    t.helper.send({
      event: 'error',
      message: '⌘⇧B is already in use by another app. Choose another with --key.',
    });
    expect(await done).toBe(1);
    expect(t.err).toEqual(['⌘⇧B is already in use by another app. Choose another with --key.']);
    expect(t.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('exits 1 when the helper dies on its own, and 0 when it dies from Ctrl+C', async () => {
    const crashed = commandSetup();
    const a = hotkeyCommand(crashed.deps);
    await flush();
    crashed.helper.emit('close', 6, null);
    expect(await a).toBe(1);
    expect(crashed.err).toEqual(['The hotkey helper stopped unexpectedly.']);

    const interrupted = commandSetup();
    const b = hotkeyCommand(interrupted.deps);
    await flush();
    interrupted.helper.emit('close', null, 'SIGINT');
    expect(await b).toBe(0);
    expect(interrupted.err).toEqual([]);
  });

  it('handles events split across chunks and ignores non-JSON lines', async () => {
    const t = commandSetup();
    const done = hotkeyCommand(t.deps);
    await flush();
    t.helper.stdout.emit('data', Buffer.from('garbage\n{"event":"pre'));
    t.helper.stdout.emit('data', Buffer.from('ssed","pid":77}\n'));
    await flush();
    expect(t.out).toContain('Capture sent to emulator-5556.');
    t.signals.emit('SIGINT');
    expect(await done).toBe(0);
  });
});
