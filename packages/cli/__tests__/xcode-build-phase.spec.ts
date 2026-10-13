// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { adviceFor } from '../src/build-verify.js';
import { DEFAULT_API_URL } from '../src/defaults.js';
import { main } from '../src/index.js';
import { XCODE_SANDBOX_MESSAGE } from '../src/native-setup/index.js';
import {
  XCODE_DEBUG_SKIP,
  XCODE_NO_TOKEN_WARNING,
  XCODE_UPLOAD_FAILED_WARNING,
  xcodeBuildPhaseCommand,
  type XcodeBuildPhaseDependencies,
} from '../src/xcode-build-phase.js';

const APP = '00000000-0000-4000-8000-000000000001';
const ENV: NodeJS.ProcessEnv = {
  CONFIGURATION: 'Release',
  SRCROOT: '/app/ios',
  CONFIGURATION_BUILD_DIR: '/derived/Release-appletvos',
  UNLOCALIZED_RESOURCES_FOLDER_PATH: 'App.app',
  SOURCEMAP_FILE: '/derived/main.jsbundle.map',
  EVERFRAME_API_TOKEN: 'secret-token',
};

type Deps = Required<XcodeBuildPhaseDependencies>;

function harness(overrides: { [K in keyof Deps]?: Deps[K] | undefined } = {}) {
  const lines: string[] = [],
    warnings: string[] = [],
    errors: string[] = [];
  const deps = {
    collect: vi.fn<Deps['collect']>(async () => ({}) as never),
    verify: vi.fn<Deps['verify']>(async () => ({ ok: true, failures: [], warnings: [] })),
    uploadHermes: vi.fn<Deps['uploadHermes']>(async () => ({ buildUuid: 'build-1' }) as never),
    dsym: vi.fn<Deps['dsym']>(async () => 0),
  };
  const output = {
    log: (line: string) => void lines.push(line),
    warn: (line: string) => void warnings.push(line),
    error: (line: string) => void errors.push(line),
  };
  const used = { ...deps, ...output, ...overrides } as XcodeBuildPhaseDependencies;
  const run = (env: NodeJS.ProcessEnv = {}, args = ['--app-id', APP]) =>
    xcodeBuildPhaseCommand(args, { ...ENV, ...env }, used);
  return { deps, lines, warnings, errors, run };
}

describe('everframe xcode build-phase', () => {
  it("uploads the Hermes bundle from Xcode's settings, then the dSYMs", async () => {
    const { deps, lines, warnings, run } = harness();
    const started = Date.now();
    expect(await run()).toBe(0);
    const staging = join('/app/ios', '..', '.everframe');
    expect(deps.collect).toHaveBeenCalledWith({
      stagingDir: staging,
      platform: 'ios',
      bundlePath: '/derived/Release-appletvos/App.app/main.jsbundle',
      mapPath: '/derived/main.jsbundle.map',
    });
    expect(deps.verify).toHaveBeenCalledWith({
      stagingDir: staging,
      platform: 'ios',
      release: true,
      allowMissing: false,
      hasToken: true,
    });
    const [options, budget] = deps.uploadHermes.mock.calls[0] as unknown as [
      Record<string, string>,
      { deadline: number },
    ];
    expect(options).toEqual({
      stagingDir: staging,
      platform: 'ios',
      appId: APP,
      apiUrl: DEFAULT_API_URL,
      token: 'secret-token',
    });
    // Build integrations get 600 seconds per upload unless EVERFRAME_UPLOAD_TIMEOUT_SECONDS says otherwise.
    expect(budget.deadline - started).toBeGreaterThanOrEqual(600_000);
    expect(budget.deadline - started).toBeLessThan(601_000);
    expect(deps.dsym).toHaveBeenCalledWith(
      ['--xcode', '--app-id', APP],
      expect.objectContaining({ EVERFRAME_API_TOKEN: 'secret-token' }),
      expect.anything(),
    );
    expect(deps.collect.mock.invocationCallOrder[0]).toBeLessThan(
      deps.dsym.mock.invocationCallOrder[0]!,
    );
    expect(lines).toEqual(['Source-map build build-1 is ready.']);
    expect(warnings).toEqual([]);
  });

  it('honors --staging, EVERFRAME_APP_ID, EVERFRAME_API_URL and EVERFRAME_UPLOAD_TIMEOUT_SECONDS', async () => {
    const { deps, run } = harness();
    const started = Date.now();
    await run(
      {
        EVERFRAME_APP_ID: APP,
        EVERFRAME_API_URL: 'https://api.test/v1',
        EVERFRAME_UPLOAD_TIMEOUT_SECONDS: '45',
      },
      ['--staging', '/js/.everframe'],
    );
    expect(deps.collect).toHaveBeenCalledWith(
      expect.objectContaining({ stagingDir: '/js/.everframe' }),
    );
    const [options, budget] = deps.uploadHermes.mock.calls[0] as unknown as [
      Record<string, string>,
      { deadline: number },
    ];
    expect(options).toMatchObject({
      stagingDir: '/js/.everframe',
      appId: APP,
      apiUrl: 'https://api.test/v1',
    });
    expect(budget.deadline - started).toBeLessThan(46_000);
  });

  it.each([{ CONFIGURATION: 'Debug' }, { SKIP_BUNDLING: '1' }])(
    'skips %o before looking at the token',
    async (env) => {
      const { deps, lines, warnings, run } = harness();
      expect(
        await run({ ...env, EVERFRAME_API_TOKEN: undefined, EVERFRAME_SYMBOLS_STRICT: '1' }),
      ).toBe(0);
      expect(lines).toEqual([XCODE_DEBUG_SKIP]);
      expect(warnings).toEqual([]);
      expect(deps.collect).not.toHaveBeenCalled();
      expect(deps.dsym).not.toHaveBeenCalled();
    },
  );

  it('warns without a token, locally and in CI, and fails only when strict', async () => {
    for (const env of [{}, { CI: '1' }, { CI: 'true' }]) {
      const { deps, warnings, run } = harness();
      expect(await run({ ...env, EVERFRAME_API_TOKEN: undefined })).toBe(0);
      expect(warnings).toEqual([XCODE_NO_TOKEN_WARNING]);
      expect(deps.collect).not.toHaveBeenCalled();
      expect(deps.dsym).not.toHaveBeenCalled();
    }
    for (const strict of ['1', 'true']) {
      const { errors, run } = harness();
      expect(await run({ EVERFRAME_API_TOKEN: undefined, EVERFRAME_SYMBOLS_STRICT: strict })).toBe(
        1,
      );
      expect(errors).toEqual([
        'error: everframe: missing_api_token: set EVERFRAME_API_TOKEN to a token with the artifacts:write scope.',
      ]);
    }
  });

  it('warns about a sandboxed phase before uploading, and fails when strict', async () => {
    const lenient = harness();
    expect(await lenient.run({ ENABLE_USER_SCRIPT_SANDBOXING: 'YES' })).toBe(0);
    expect(lenient.warnings).toEqual([`warning: everframe: ${XCODE_SANDBOX_MESSAGE}`]);
    expect(lenient.deps.collect).not.toHaveBeenCalled();
    const strict = harness();
    expect(
      await strict.run({ ENABLE_USER_SCRIPT_SANDBOXING: 'YES', EVERFRAME_SYMBOLS_STRICT: '1' }),
    ).toBe(1);
    expect(strict.errors).toEqual([`error: everframe: ${XCODE_SANDBOX_MESSAGE}`]);
  });

  it('still uploads dSYMs when the Hermes upload fails, and stops there when strict', async () => {
    const failing = () =>
      harness({
        collect: vi.fn(async () => {
          throw new Error('staged_partial_missing');
        }),
      });
    const lenient = failing();
    expect(await lenient.run()).toBe(0);
    expect(lenient.warnings).toEqual([
      `warning: everframe: ${adviceFor('staged_partial_missing')}`,
      XCODE_UPLOAD_FAILED_WARNING,
    ]);
    expect(lenient.deps.uploadHermes).not.toHaveBeenCalled();
    expect(lenient.deps.dsym).toHaveBeenCalled();
    const strict = failing();
    expect(await strict.run({ EVERFRAME_SYMBOLS_STRICT: '1' })).toBe(1);
    expect(strict.errors).toEqual([`error: everframe: ${adviceFor('staged_partial_missing')}`]);
    expect(strict.deps.dsym).not.toHaveBeenCalled();
  });

  it('turns verify failures and upload errors into warnings, without the token', async () => {
    const verify = harness({
      verify: vi.fn(async () => ({
        ok: false,
        failures: ['no_staged_build: a', 'b'],
        warnings: [],
      })),
    });
    expect(await verify.run()).toBe(0);
    expect(verify.warnings).toEqual([
      'warning: everframe: no_staged_build: a',
      'warning: everframe: b',
      XCODE_UPLOAD_FAILED_WARNING,
    ]);
    const upload = harness({
      uploadHermes: vi.fn(async () => {
        throw new Error('request_failed: 401 for secret-token');
      }),
    });
    expect(await upload.run()).toBe(0);
    expect(upload.warnings[0]).toBe('warning: everframe: request_failed: 401 for [redacted]');
    expect(upload.deps.dsym).toHaveBeenCalled();
  });

  it('explains a missing SOURCEMAP_FILE or bundle with the collect advice', async () => {
    const noMap = harness();
    expect(await noMap.run({ SOURCEMAP_FILE: '' })).toBe(0);
    expect(noMap.warnings[0]).toBe(`warning: everframe: ${adviceFor('source_map_not_found')}`);
    expect(noMap.deps.collect).not.toHaveBeenCalled();
    // The real collect step: there is no bundle at the path Xcode names.
    const real = harness({ collect: undefined });
    expect(await real.run({ CONFIGURATION_BUILD_DIR: '/nonexistent' })).toBe(0);
    expect(real.warnings[0]).toBe(`warning: everframe: ${adviceFor('bundle_not_found')}`);
  });

  it('fails when the dSYM upload fails in strict mode', async () => {
    const { errors, run } = harness({
      dsym: vi.fn(async () => {
        throw new Error('upload failed for secret-token');
      }),
    });
    expect(await run({ EVERFRAME_SYMBOLS_STRICT: '1' })).toBe(1);
    expect(errors).toEqual(['error: everframe: upload failed for [redacted]']);
  });

  it('requires an application UUID', async () => {
    const { run } = harness();
    await expect(run({}, [])).rejects.toThrow(/missing_app_id/);
    await expect(run({}, ['--app-id', 'nope'])).rejects.toThrow(/UUID/);
  });

  it('is reachable as `everframe xcode build-phase`', async () => {
    const lines: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((line: string) => void lines.push(line));
    try {
      expect(
        await main(['xcode', 'build-phase', '--app-id', APP], { CONFIGURATION: 'Debug' }),
      ).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(lines).toEqual([XCODE_DEBUG_SKIP]);
  });
});
