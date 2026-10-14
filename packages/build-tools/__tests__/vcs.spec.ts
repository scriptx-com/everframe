// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { detectBuildVcs, overrideBuildVcs } from '../src/vcs.js';
const roots: string[] = [];
function directory() {
  const p = mkdtempSync(join(tmpdir(), 'vcs-test-'));
  roots.push(p);
  return p;
}
function git(root: string, ...args: string[]) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}
function repo() {
  const root = directory();
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(root, 'source'), 'one');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return { root, commit: git(root, 'rev-parse', 'HEAD') };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('uses local HEAD ahead of CI and captures clean nested worktrees', () => {
  const { root, commit } = repo();
  mkdirSync(join(root, 'app'));
  expect(
    detectBuildVcs({ projectRoot: join(root, 'app'), env: { GITHUB_SHA: 'b'.repeat(40) } }),
  ).toEqual({ commit, branch: 'main', dirty: false });
});
it.each(['staged', 'unstaged', 'untracked'])('captures %s changes', (mode) => {
  const { root } = repo();
  writeFileSync(join(root, mode === 'untracked' ? 'new' : 'source'), 'changed');
  if (mode === 'staged') git(root, 'add', '.');
  expect(detectBuildVcs({ projectRoot: root, env: {} })?.dirty).toBe(true);
});
it('ignores ignored files and omits detached branch', () => {
  const { root, commit } = repo();
  writeFileSync(join(root, '.git/info/exclude'), 'ignored\n');
  writeFileSync(join(root, 'ignored'), 'x');
  git(root, 'checkout', '--detach');
  expect(detectBuildVcs({ projectRoot: root, env: {} })).toEqual({ commit, dirty: false });
});
it('an explicit different commit never inherits local branch or dirty', () => {
  const { root } = repo();
  expect(detectBuildVcs({ projectRoot: root, commit: 'B'.repeat(64), env: {} })).toEqual({
    commit: 'b'.repeat(64),
  });
});
it('falls back through valid CI variables, or omits unavailable provenance', () => {
  const root = directory();
  expect(detectBuildVcs({ projectRoot: root, env: {} })).toBeUndefined();
  expect(
    detectBuildVcs({
      projectRoot: root,
      env: { GITHUB_SHA: 'bad', CI_COMMIT_SHA: 'C'.repeat(40), BITBUCKET_COMMIT: 'd'.repeat(40) },
    }),
  ).toEqual({ commit: 'c'.repeat(40) });
});
it('rejects an invalid explicit commit rather than falling back', () => {
  expect(() =>
    detectBuildVcs({
      projectRoot: directory(),
      commit: 'abc',
      env: { GITHUB_SHA: 'a'.repeat(40) },
    }),
  ).toThrow('invalid_commit');
});
it('overrides only the recorded identity and preserves unknown facts', () => {
  const recorded = { commit: 'a'.repeat(40), branch: 'old', dirty: true };
  expect(overrideBuildVcs(recorded)).toEqual(recorded);
  expect(overrideBuildVcs(recorded, 'A'.repeat(40))).toEqual(recorded);
  expect(overrideBuildVcs(recorded, 'b'.repeat(40))).toEqual({ commit: 'b'.repeat(40) });
  expect(overrideBuildVcs(undefined)).toBeUndefined();
  expect(() => overrideBuildVcs(recorded, '')).toThrow('invalid_commit');
});
it('keeps a commit when status fails, and bounds Git execution', async () => {
  const { default: child } = await import('node:child_process');
  const spy = vi.spyOn(child, 'execFileSync').mockImplementation((file, args, options) => {
    expect(file).toBe('git');
    expect(options).toMatchObject({ timeout: 1500, maxBuffer: 65536 });
    if (args?.[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
    if (args?.[0] === 'symbolic-ref') return 'main\n';
    throw new Error('timeout');
  });
  expect(detectBuildVcs({ projectRoot: directory(), env: {} })).toEqual({
    commit: 'a'.repeat(40),
    branch: 'main',
  });
  spy.mockRestore();
});
it('uses CI when Git is unavailable', async () => {
  const { default: child } = await import('node:child_process');
  vi.spyOn(child, 'execFileSync').mockImplementation(() => {
    throw new Error('ENOENT');
  });
  expect(
    detectBuildVcs({ projectRoot: directory(), env: { BUILD_SOURCEVERSION: 'a'.repeat(40) } }),
  ).toEqual({ commit: 'a'.repeat(40) });
});
