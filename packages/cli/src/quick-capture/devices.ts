// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, join } from 'node:path';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
/** `signal` kills the child when aborted. */
export type Runner = (
  cmd: string,
  args: string[],
  options?: { signal?: AbortSignal },
) => Promise<RunResult>;

/** Runs a command with an argument array (never a shell); never rejects. */
export const runnerWithTimeout =
  (timeoutMs: number): Runner =>
  (cmd, args, options) =>
    new Promise((resolve) => {
      execFile(
        cmd,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          ...(options?.signal ? { signal: options.signal } : {}),
        },
        (error, stdout, stderr) => {
          if (!error) return resolve({ stdout, stderr, code: 0 });
          const code = typeof error.code === 'number' ? error.code : 127;
          // error.message embeds the full command line (arguments included), so it
          // is never surfaced: a pushed token would leak through it.
          resolve({
            stdout: stdout ?? '',
            stderr: stderr || `Couldn't run ${basename(cmd)}`,
            code,
          });
        },
      );
    });

export const defaultRunner: Runner = runnerWithTimeout(15_000);

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findAdb(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string | null {
  const name = platform === 'win32' ? 'adb.exe' : 'adb';
  const candidates: string[] = [];
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (root) candidates.push(join(root, 'platform-tools', name));
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir) candidates.push(join(dir, name));
  }
  // Default Android Studio SDK folders, used when nothing else is configured.
  if (platform === 'darwin') {
    candidates.push(join(home, 'Library', 'Android', 'sdk', 'platform-tools', name));
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local) candidates.push(join(local, 'Android', 'Sdk', 'platform-tools', name));
  } else {
    candidates.push(join(home, 'Android', 'Sdk', 'platform-tools', name));
  }
  return candidates.find(executable) ?? null;
}

const EMULATOR_SERIAL = /^emulator-\d+$/;

export async function listEmulators(run: Runner, adb: string): Promise<string[]> {
  const result = await run(adb, ['devices']);
  if (result.code !== 0) return [];
  const serials: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state === 'device' && EMULATOR_SERIAL.test(serial)) serials.push(serial);
  }
  return serials;
}

export interface Simulator {
  udid: string;
  name: string;
}

export async function listBootedSimulators(
  run: Runner,
  platform: NodeJS.Platform = process.platform,
): Promise<Simulator[]> {
  if (platform !== 'darwin') return [];
  const result = await run('xcrun', ['simctl', 'list', 'devices', 'booted', '--json']);
  if (result.code !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout) as {
      devices?: Record<string, { udid?: unknown; name?: unknown; state?: unknown }[]>;
    };
    const found: Simulator[] = [];
    for (const [runtime, list] of Object.entries(parsed.devices ?? {})) {
      if (!runtime.includes('.SimRuntime.iOS-') || !Array.isArray(list)) continue;
      for (const d of list) {
        if (typeof d.udid === 'string' && typeof d.name === 'string' && d.state !== 'Shutdown') {
          found.push({ udid: d.udid, name: d.name });
        }
      }
    }
    return found;
  } catch {
    return [];
  }
}

const TOKEN_SETTING = 'everframe_token';
// The origin that issued the token. The SDK attaches the token only when this
// matches its ingest endpoint; with no origin it sends it as before.
const TOKEN_ORIGIN_SETTING = 'everframe_token_origin';

/** The origin (scheme, host, port) of an http(s) URL, or null. */
export function tokenOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * Writes the issuing origin before the token, so the emulator never pairs the
 * new token with a stale origin. Without an origin, any earlier one is removed.
 */
export async function pushToken(
  run: Runner,
  adb: string,
  serial: string,
  token: string,
  origin: string | null,
): Promise<RunResult> {
  const settings = ['-s', serial, 'shell', 'settings'];
  const recorded = await run(
    adb,
    origin
      ? [...settings, 'put', 'global', TOKEN_ORIGIN_SETTING, origin]
      : [...settings, 'delete', 'global', TOKEN_ORIGIN_SETTING],
  );
  if (recorded.code !== 0) return recorded;
  return run(adb, [...settings, 'put', 'global', TOKEN_SETTING, token]);
}

/** Removes the token first, then its origin. */
export async function clearToken(run: Runner, adb: string, serial: string): Promise<RunResult> {
  const settings = ['-s', serial, 'shell', 'settings', 'delete', 'global'];
  const cleared = await run(adb, [...settings, TOKEN_SETTING]);
  const origin = await run(adb, [...settings, TOKEN_ORIGIN_SETTING]);
  return cleared.code !== 0 ? cleared : origin;
}

export async function triggerSimulator(run: Runner, udid: string): Promise<RunResult> {
  return run('xcrun', ['simctl', 'spawn', udid, 'notifyutil', '-p', 'com.everframe.capture']);
}

export async function triggerEmulator(
  run: Runner,
  adb: string,
  serial: string,
): Promise<RunResult> {
  return run(adb, ['-s', serial, 'shell', 'am', 'broadcast', '-a', 'com.everframe.CAPTURE']);
}
