// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('packed CLI and Metro capture provenance without workspace support packages', () => {
  const root = mkdtempSync(join(tmpdir(), 'everframe-packed-vcs-'));
  const cli = resolve(import.meta.dirname, '..');
  const metro = resolve(cli, '../metro');
  const run = (command: string, args: string[], cwd = root) =>
    execFileSync(command, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
  try {
    // CLI's test script builds it; Metro must also be current for standalone runs.
    run('pnpm', ['build'], metro);
    for (const [name, source] of [
      ['cli', cli],
      ['metro', metro],
    ]) {
      const pkg = JSON.parse(readFileSync(join(source!, 'package.json'), 'utf8'));
      run('pnpm', ['pack', '--pack-destination', root], source);
      const target = join(root, 'node_modules/@everframe', name!);
      mkdirSync(target, { recursive: true });
      run('tar', [
        '-xzf',
        join(root, `everframe-${name}-${pkg.version}.tgz`),
        '-C',
        target,
        '--strip-components=1',
      ]);
      // Only declared published dependencies are available to the extracted code.
      for (const dep of Object.keys(pkg.dependencies)) {
        const destination = join(target, 'node_modules', dep);
        mkdirSync(join(destination, '..'), { recursive: true });
        symlinkSync(
          dirname(createRequire(join(source!, 'package.json')).resolve(`${dep}/package.json`)),
          destination,
          'dir',
        );
      }
      expect(Object.keys(pkg.dependencies)).not.toContain('@everframe/build-tools');
      expect(Object.keys(pkg.dependencies)).not.toContain('@everframe/protocol');
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(root, 'smoke.mjs'),
      `
      import { withEverframe } from '@everframe/metro';
      import { main } from '@everframe/cli';
      import { readFileSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const projectRoot = process.cwd();
      withEverframe({}, { projectRoot });
      const { buildId } = JSON.parse(readFileSync('.everframe/latest-ios.json', 'utf8'));
      const partial = JSON.parse(readFileSync(join('.everframe', buildId, 'manifest.partial.json'), 'utf8'));
      writeFileSync('mapping.txt', '# mapping');
      let uploaded;
      globalThis.fetch = async (_url, init) => {
        uploaded = JSON.parse(init.body);
        return Response.json({ buildUuid: 'b', status: 'ready', artifacts: uploaded.artifacts.map(a => ({ artifactUuid: 'a', url: a.url, available: true })) });
      };
      const code = await main(['r8','upload','--mapping-id','build-a','--mapping','mapping.txt','--app-id','app'], { EVERFRAME_API_TOKEN: 'test', EVERFRAME_API_URL: 'https://api.example' });
      if (code !== 0) throw new Error('CLI failed');
      console.log('RESULT:' + JSON.stringify({ metro: partial.vcs, cli: uploaded.vcs }));
    `,
    );
    const env = { ...process.env };
    for (const key of ['GITHUB_SHA', 'CI_COMMIT_SHA', 'BITBUCKET_COMMIT', 'BUILD_SOURCEVERSION'])
      delete env[key];
    const smoke = () => {
      const output = execFileSync(process.execPath, [join(root, 'smoke.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env,
      });
      return JSON.parse(output.split('RESULT:')[1]!);
    };
    expect(smoke()).toEqual({});
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.name', 'Test']);
    run('git', ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.everframe/\n*.tgz\n');
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'source']);
    const commit = run('git', ['rev-parse', 'HEAD']).trim();
    expect(smoke()).toEqual({
      metro: { commit, branch: 'main', dirty: false },
      cli: { commit, branch: 'main', dirty: false },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
