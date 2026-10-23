// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

/** Runs a command with an argument array (never a shell); never rejects. */
export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve({ stdout, stderr, code: 0 });
      const code = typeof error.code === 'number' ? error.code : 127;
      // error.message embeds the full command line (arguments included), so it
      // is never surfaced: a pushed token would leak through it.
      resolve({ stdout: stdout ?? '', stderr: stderr || `Couldn't run ${basename(cmd)}`, code });
    });
  });

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export function findAdb(env: NodeJS.ProcessEnv): string | null {
  for (const root of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) {
    if (!root) continue;
    const candidate = join(root, 'platform-tools', 'adb');
    if (executable(candidate)) return candidate;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'adb');
    if (executable(candidate)) return candidate;
  }
  return null;
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
    for (const list of Object.values(parsed.devices ?? {})) {
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

export async function pushToken(
  run: Runner,
  adb: string,
  serial: string,
  token: string,
): Promise<RunResult> {
  return run(adb, ['-s', serial, 'shell', 'settings', 'put', 'global', 'everframe_token', token]);
}

export async function clearToken(run: Runner, adb: string, serial: string): Promise<RunResult> {
  return run(adb, ['-s', serial, 'shell', 'settings', 'delete', 'global', 'everframe_token']);
}

export async function triggerSimulator(run: Runner, udid: string): Promise<RunResult> {
  return run('xcrun', ['simctl', 'spawn', udid, 'notifyutil', '-p', 'com.everframe.capture']);
}

export async function triggerEmulator(run: Runner, adb: string, serial: string): Promise<RunResult> {
  return run(adb, ['-s', serial, 'shell', 'am', 'broadcast', '-a', 'com.everframe.CAPTURE']);
}
