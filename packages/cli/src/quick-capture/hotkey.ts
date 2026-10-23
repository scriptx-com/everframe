// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from '../defaults.js';
import type { QuickCaptureDeps } from './commands.js';
import { readCredentials } from './credentials.js';
import { type Runner, findAdb, listEmulators, triggerEmulator } from './devices.js';

export interface Hotkey {
  keyCode: number;
  modifiers: number;
}

// Carbon modifier bits (HIToolbox/Events.h).
const CMD = 256;
const SHIFT = 512;
const OPTION = 2048;
const CONTROL = 4096;

// Maps, not plain objects, so inherited keys like `constructor` or `__proto__` never match.
const MODIFIER_TOKENS = new Map<string, number>(
  Object.entries({
    cmd: CMD,
    command: CMD,
    '⌘': CMD,
    ctrl: CONTROL,
    control: CONTROL,
    '⌃': CONTROL,
    alt: OPTION,
    opt: OPTION,
    option: OPTION,
    '⌥': OPTION,
    shift: SHIFT,
    '⇧': SHIFT,
  }),
);

// kVK_ANSI_* and kVK_F* virtual key codes (HIToolbox/Events.h).
const KEY_CODES = new Map<string, number>(
  Object.entries({
    A: 0x00,
    S: 0x01,
    D: 0x02,
    F: 0x03,
    H: 0x04,
    G: 0x05,
    Z: 0x06,
    X: 0x07,
    C: 0x08,
    V: 0x09,
    B: 0x0b,
    Q: 0x0c,
    W: 0x0d,
    E: 0x0e,
    R: 0x0f,
    Y: 0x10,
    T: 0x11,
    O: 0x1f,
    U: 0x20,
    I: 0x22,
    P: 0x23,
    L: 0x25,
    J: 0x26,
    K: 0x28,
    N: 0x2d,
    M: 0x2e,
    '1': 0x12,
    '2': 0x13,
    '3': 0x14,
    '4': 0x15,
    '6': 0x16,
    '5': 0x17,
    '9': 0x19,
    '7': 0x1a,
    '8': 0x1c,
    '0': 0x1d,
    F1: 0x7a,
    F2: 0x78,
    F3: 0x63,
    F4: 0x76,
    F5: 0x60,
    F6: 0x61,
    F7: 0x62,
    F8: 0x64,
    F9: 0x65,
    F10: 0x6d,
    F11: 0x67,
    F12: 0x6f,
  }),
);

const ACCEPTED =
  'Use a combo like Cmd+Shift+B: Cmd or Ctrl (plus Alt or Shift if you like) and one key from A-Z, 0-9 or F1-F12.';

export const DEFAULT_HOTKEY = 'Cmd+Shift+B';

export function parseHotkey(spec: string): Hotkey {
  let modifiers = 0;
  let key: string | undefined;
  for (const raw of spec.split('+')) {
    const token = raw.trim();
    const modifier = MODIFIER_TOKENS.get(token.toLowerCase());
    if (modifier !== undefined) {
      modifiers |= modifier;
      continue;
    }
    const upper = token.toUpperCase();
    if (key !== undefined || !KEY_CODES.has(upper))
      throw new Error(`Invalid --key "${spec}". ${ACCEPTED}`);
    key = upper;
  }
  // macOS 15+ refuses hotkeys whose only modifiers are Option or Option+Shift.
  if (key === undefined || (modifiers & (CMD | CONTROL)) === 0) {
    throw new Error(`Invalid --key "${spec}". ${ACCEPTED}`);
  }
  return { keyCode: KEY_CODES.get(key) as number, modifiers };
}

export function formatHotkey(hotkey: Hotkey): string {
  const key = [...KEY_CODES].find(([, code]) => code === hotkey.keyCode)?.[0] ?? '?';
  return (
    (hotkey.modifiers & CMD ? '⌘' : '') +
    (hotkey.modifiers & CONTROL ? '⌃' : '') +
    (hotkey.modifiers & OPTION ? '⌥' : '') +
    (hotkey.modifiers & SHIFT ? '⇧' : '') +
    key
  );
}

/** sha256 of the helper source plus the compiler version, so either change rebuilds. */
export function helperHash(source: string, swiftcVersion: string): string {
  return createHash('sha256').update(source).update('\0').update(swiftcVersion).digest('hex');
}

export function helperBinaryPath(home: string, sourceHash: string): string {
  return join(home, '.everframe', 'bin', `hotkey-${sourceHash.slice(0, 12)}`);
}

/** The Swift source ships in the package's helpers/ directory, next to dist/ (or src/). */
export function defaultHelperSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'helpers', 'hotkey-macos.swift'),
    join(here, '..', '..', 'helpers', 'hotkey-macos.swift'),
  ];
  return candidates.find((c) => existsSync(c)) ?? (candidates[0] as string);
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export type EnsureHelperResult =
  | { path: string }
  | { error: 'no-swiftc' }
  | { error: 'compile-failed'; detail: string };

export interface EnsureHelperDeps {
  run: Runner;
  home: string;
  /** Path to hotkey-macos.swift; defaults to the copy shipped with the package. */
  source?: string;
  /** Runner for the compile step, which can outlast the default runner's timeout. */
  compile?: Runner;
}

const fsReason = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? `${code} while saving the helper` : 'could not save the helper';
};

export async function ensureHelper(deps: EnsureHelperDeps): Promise<EnsureHelperResult> {
  const version = await deps.run('xcrun', ['swiftc', '--version']);
  if (version.code !== 0) return { error: 'no-swiftc' };
  const source = deps.source ?? defaultHelperSource();
  let text: string;
  try {
    text = readFileSync(source, 'utf8');
  } catch {
    return { error: 'compile-failed', detail: `Couldn't read ${source}.` };
  }
  const path = helperBinaryPath(deps.home, helperHash(text, version.stdout + version.stderr));
  if (executable(path)) return { path };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    return { error: 'compile-failed', detail: fsReason(error) };
  }
  const tmp = `${path}.${process.pid}.tmp`;
  const built = await (deps.compile ?? deps.run)('xcrun', ['swiftc', '-O', '-o', tmp, source]);
  if (built.code !== 0 || !existsSync(tmp)) {
    rmSync(tmp, { force: true });
    const detail =
      built.stderr.split('\n').find((l) => /error/i.test(l)) ?? built.stderr.split('\n')[0] ?? '';
    return { error: 'compile-failed', detail: detail.trim().slice(0, 512) };
  }
  try {
    chmodSync(tmp, 0o755);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    return { error: 'compile-failed', detail: fsReason(error) };
  }
  return { path };
}

// The emulator launcher starts qemu either as `-avd <name>` or `@<name>`.
const AVD_ARG = /(?:^|\s)(?:-avd\s+|@)(\S+)/;

/** Maps the front qemu process to its adb serial via its AVD name. */
export async function serialForPid(run: Runner, adb: string, pid: number): Promise<string | null> {
  const ps = await run('ps', ['-o', 'command=', '-p', String(pid)]);
  if (ps.code !== 0) return null;
  const avd = AVD_ARG.exec(ps.stdout.trim())?.[1];
  if (!avd) return null;
  for (const serial of await listEmulators(run, adb)) {
    const reply = await run(adb, ['-s', serial, 'emu', 'avd', 'name']);
    if (reply.code !== 0) continue;
    if ((reply.stdout.split('\n')[0] ?? '').trim() === avd) return serial;
  }
  return null;
}

export interface HelperProcess {
  stdout: {
    setEncoding(encoding: BufferEncoding): unknown;
    on(event: 'data', listener: (chunk: string) => void): unknown;
  } | null;
  /** 'close' rather than 'exit': it fires only after stdout is drained, so a final error line is never lost. */
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SignalSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface HotkeyDeps extends QuickCaptureDeps {
  ensure?: () => Promise<EnsureHelperResult>;
  spawnHelper?: (path: string, args: string[]) => HelperProcess;
  signals?: SignalSource;
}

const defaultSpawnHelper = (path: string, args: string[]): HelperProcess =>
  spawn(path, args, { stdio: ['ignore', 'pipe', 'inherit'] });

export async function hotkeyCommand(
  deps: HotkeyDeps,
  options: { key?: string } = {},
): Promise<number> {
  if ((deps.platform ?? process.platform) !== 'darwin') {
    deps.err(
      'The hotkey helper runs on macOS. On Windows and Linux, bind "npx @everframe/cli capture" to a keyboard shortcut in your desktop settings.',
    );
    return 1;
  }
  let hotkey: Hotkey;
  try {
    hotkey = parseHotkey(options.key ?? DEFAULT_HOTKEY);
  } catch (error) {
    deps.err((error as Error).message);
    return 1;
  }
  const helper = await (deps.ensure ?? (() => ensureHelper({ run: deps.run, home: deps.home })))();
  if ('error' in helper) {
    deps.err(
      helper.error === 'no-swiftc'
        ? 'The hotkey helper needs the Xcode Command Line Tools: xcode-select --install'
        : `Couldn't build the hotkey helper: ${helper.detail}`,
    );
    return 1;
  }

  const child = (deps.spawnHelper ?? defaultSpawnHelper)(helper.path, [
    '--keycode',
    String(hotkey.keyCode),
    '--modifiers',
    String(hotkey.modifiers),
  ]);
  const signals = deps.signals ?? process;
  const combo = formatHotkey(hotkey);

  return new Promise<number>((resolve) => {
    let finished = false;
    let presses = Promise.resolve();
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      signals.off('SIGINT', onInterrupt);
      resolve(code);
    };
    const stop = (code: number) => {
      if (finished) return;
      child.kill('SIGTERM');
      finish(code);
    };
    function onInterrupt() {
      stop(0);
    }

    const capture = async (pid: number) => {
      const adb = findAdb(deps.env, process.platform, deps.home);
      if (!adb) {
        deps.err("Couldn't find adb. Install the Android SDK platform-tools or set ANDROID_HOME.");
        return;
      }
      const serial = await serialForPid(deps.run, adb, pid);
      if (!serial) {
        deps.err("Couldn't match the front emulator window to a running emulator.");
        return;
      }
      const result = await triggerEmulator(deps.run, adb, serial);
      if (result.code !== 0) {
        const token = readCredentials(deps.home)?.token;
        deps.err(redact(result.stderr.trim() || `Couldn't reach ${serial}.`, token).slice(0, 256));
        return;
      }
      deps.out(`Capture sent to ${serial}.`);
    };

    const handle = (line: string) => {
      let event: { event?: unknown; pid?: unknown; message?: unknown };
      try {
        event = JSON.parse(line) as typeof event;
      } catch {
        return;
      }
      if (event.event === 'ready') {
        deps.out(
          `Press ${combo} with an Android emulator window in front to capture it. Ctrl+C to stop.`,
        );
        deps.out(
          'Emulators embedded in Android Studio need Settings → Tools → Emulator → "Launch in the Running Devices tool window" turned off, or use npx @everframe/cli capture.',
        );
      } else if (event.event === 'pressed' && typeof event.pid === 'number') {
        const pid = event.pid;
        presses = presses.then(() => capture(pid)).catch(() => undefined);
      } else if (event.event === 'error') {
        deps.err(typeof event.message === 'string' ? event.message : 'The hotkey helper failed.');
        stop(1);
      }
    };

    let buffered = '';
    // Decode as UTF-8 at the stream so a ⌘ split across two chunks stays intact.
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffered += chunk;
      let newline = buffered.indexOf('\n');
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) handle(line);
        newline = buffered.indexOf('\n');
      }
    });
    child.on('error', () => {
      if (finished) return;
      deps.err("Couldn't start the hotkey helper.");
      finish(1);
    });
    child.on('close', (_code, signal) => {
      if (finished) return;
      // Ctrl+C reaches the whole foreground process group, so the helper can
      // exit before our own SIGINT listener runs.
      if (signal === 'SIGINT') return finish(0);
      deps.err('The hotkey helper stopped unexpectedly.');
      finish(1);
    });
    signals.on('SIGINT', onInterrupt);
  });
}
