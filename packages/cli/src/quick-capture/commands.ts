// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { redact } from '../defaults.js';
import { readCredentials } from './credentials.js';
import {
  type Runner,
  findAdb,
  listBootedSimulators,
  listEmulators,
  pushToken,
  tokenOrigin,
  triggerEmulator,
  triggerSimulator,
} from './devices.js';

export interface QuickCaptureDeps {
  run: Runner;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Defaults to process.platform; simulators exist only on darwin. */
  platform?: NodeJS.Platform;
  out: (s: string) => void;
  err: (s: string) => void;
}

export interface EmulatorLinkResult {
  serial: string;
  ok: boolean;
}

/**
 * Pushes the token to every running emulator. Quiet: the caller prints.
 * Returns an empty list when adb is missing or no emulator is running.
 */
export async function pushTokenToEmulators(
  deps: Pick<QuickCaptureDeps, 'run' | 'env' | 'home'>,
  token: string,
  issuer: string,
): Promise<EmulatorLinkResult[]> {
  const adb = findAdb(deps.env, process.platform, deps.home);
  if (!adb) return [];
  const origin = tokenOrigin(issuer);
  const results: EmulatorLinkResult[] = [];
  for (const serial of await listEmulators(deps.run, adb)) {
    const pushed = await pushToken(deps.run, adb, serial, token, origin);
    results.push({ serial, ok: pushed.code === 0 });
  }
  return results;
}

export async function linkCommand(deps: QuickCaptureDeps): Promise<number> {
  const credentials = readCredentials(deps.home);
  if (!credentials) {
    deps.err('Not logged in. Run npx @everframe/cli login first.');
    return 1;
  }
  const results = await pushTokenToEmulators(deps, credentials.token, credentials.url);
  if (results.length === 0) {
    deps.out('No running Android emulators. iOS simulators read your login automatically.');
    return 0;
  }
  for (const r of results) deps.out(r.ok ? `Linked ${r.serial}` : `Couldn't link ${r.serial}`);
  return results.some((r) => r.ok) ? 0 : 1;
}

interface Target {
  id: string;
  name: string;
  fire: () => Promise<{ stderr: string; code: number }>;
}

export async function captureCommand(
  deps: QuickCaptureDeps,
  options: { device?: string } = {},
): Promise<number> {
  const targets: Target[] = [];
  for (const sim of await listBootedSimulators(deps.run, deps.platform)) {
    targets.push({
      id: sim.udid,
      name: sim.name,
      fire: () => triggerSimulator(deps.run, sim.udid),
    });
  }
  const adb = findAdb(deps.env, process.platform, deps.home);
  if (adb) {
    for (const serial of await listEmulators(deps.run, adb)) {
      targets.push({
        id: serial,
        name: serial,
        fire: () => triggerEmulator(deps.run, adb, serial),
      });
    }
  }
  const wanted = options.device;
  const matches = wanted ? targets.filter((t) => t.id === wanted || t.name === wanted) : targets;
  if (matches.length === 0) {
    deps.err(
      wanted
        ? `No booted simulator or running emulator matches ${wanted}.`
        : 'No booted simulator or running emulator.',
    );
    return 1;
  }
  if (matches.length > 1) {
    for (const t of matches) deps.out(`${t.id}  ${t.name}`);
    deps.out('Pick one with --device <id>.');
    return 2;
  }
  const target = matches[0] as Target;
  const result = await target.fire();
  if (result.code !== 0) {
    const token = readCredentials(deps.home)?.token;
    deps.err(redact(result.stderr.trim() || `Couldn't reach ${target.name}.`, token).slice(0, 256));
    return 1;
  }
  deps.out(`Capture sent to ${target.name}.`);
  return 0;
}
