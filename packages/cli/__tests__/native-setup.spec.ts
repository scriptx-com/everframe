// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import xcode from 'xcode';
import {
  buildPhaseScript,
  patchAppBuildGradle,
  patchXcodeProject,
  SOURCEMAP_FILE_VALUE,
  SYMBOLS_BUILD_SETTINGS,
  SYMBOLS_PHASE_INPUTS,
  XCODE_PHASE_NAME,
} from '../src/native-setup/index.js';

const APP = '00000000-0000-4000-8000-000000000000';
const GRADLE = "apply plugin: \"com.android.application\"\n\nandroid {\n}\n";
const loadProject = () => {
  const project = xcode.project(join(__dirname, 'fixtures/ios/project.pbxproj'));
  project.parseSync();
  return project;
};

describe('buildPhaseScript', () => {
  const ios = buildPhaseScript({ platform: 'ios', appId: APP, stagingDir: '$SRCROOT/../.everframe', projectRoot: '$SRCROOT/..' });
  const android = buildPhaseScript({ platform: 'android', appId: APP, stagingDir: '$EVERFRAME_STAGING', projectRoot: '..' });

  it('resolves the cli through node from the project root, never from PATH', () => {
    expect(ios).toContain(`require.resolve('@everframe/cli')`);
    expect(ios).not.toMatch(/^everframe /m);
    expect(ios).toContain('"$EVERFRAME_NODE" "$EVERFRAME_CLI" build collect');
  });

  it('loads the xcode node environment on ios only', () => {
    expect(ios).toContain('.xcode.env');
    expect(android).not.toContain('.xcode.env');
  });

  it('keeps collect, verify, upload order and fail-fast', () => {
    expect(ios).toContain('set -euo pipefail');
    expect(ios.indexOf('build collect')).toBeLessThan(ios.indexOf('build verify'));
    expect(ios.indexOf('build verify')).toBeLessThan(ios.indexOf('upload-hermes'));
  });

  it('keeps every everframe call on one line', () => {
    expect(ios).not.toMatch(/\\\n/);
  });

  it('reads the ios map from SOURCEMAP_FILE with a default', () => {
    expect(ios).toContain('"${SOURCEMAP_FILE:-}"');
  });

  it('skips iOS Debug builds before it looks at the token', () => {
    expect(ios.indexOf('"${CONFIGURATION:-}" = "Debug"')).toBeLessThan(ios.indexOf('EVERFRAME_API_TOKEN'));
    expect(ios).toContain('[ -n "${SKIP_BUNDLING:-}" ]');
  });

  const run = (script: string, env: Record<string, string>) =>
    spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, CONFIGURATION: 'Release', ...env }, encoding: 'utf8' });

  it.each(['ios', 'android'] as const)('%s warns without a token, locally and in CI, and fails only when strict', (platform) => {
    const script = platform === 'ios' ? ios : android;
    for (const env of [{}, { CI: '1' }, { CI: 'true' }]) {
      const result = run(script, env);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('warning: everframe: no EVERFRAME_API_TOKEN, skipping artifact upload');
    }
    const strict = run(script, { EVERFRAME_SYMBOLS_STRICT: '1' });
    expect(strict.status).toBe(1);
    expect(strict.stderr).toContain('missing_api_token');
  });

  it.each(['ios', 'android'] as const)('%s turns a failed upload step into a warning unless strict', (platform) => {
    const script = platform === 'ios' ? ios : android;
    const env = { EVERFRAME_API_TOKEN: 't', NODE_BINARY: '/nonexistent/node', SRCROOT: '/nonexistent' };
    const lenient = run(script, env);
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain('warning: everframe: artifact upload failed');
    expect(run(script, { ...env, EVERFRAME_SYMBOLS_STRICT: '1' }).status).not.toBe(0);
  });

  it('warns about a sandboxed iOS phase before starting Node, and fails when strict', () => {
    const lenient = run(ios, { EVERFRAME_API_TOKEN: 't', ENABLE_USER_SCRIPT_SANDBOXING: 'YES', NODE_BINARY: '/nonexistent/node' });
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain('warning: everframe: xcode_script_sandboxed: ');
    expect(lenient.stdout).not.toContain('artifact upload failed');
    const strict = run(ios, { EVERFRAME_API_TOKEN: 't', ENABLE_USER_SCRIPT_SANDBOXING: 'YES', EVERFRAME_SYMBOLS_STRICT: '1' });
    expect(strict.status).toBe(1);
  });

  it("tolerates unset variables in the project's .xcode.env", () => {
    const srcroot = mkdtempSync(join(tmpdir(), 'everframe-rn-env-'));
    writeFileSync(join(srcroot, '.xcode.env'), 'export EVERFRAME_TEST_FROM_ENV="$EVERFRAME_TEST_NEVER_SET"\n');
    const result = run(ios, { EVERFRAME_API_TOKEN: 't', SRCROOT: srcroot, NODE_BINARY: '/nonexistent/node' });
    expect(result.stderr).not.toContain('unbound variable');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('warning: everframe: artifact upload failed');
  });

  it('still uploads iOS dSYMs when the Hermes upload fails', () => {
    const dir = mkdtempSync(join(tmpdir(), 'everframe-rn-steps-'));
    const record = join(dir, 'steps.txt'), node = join(dir, 'node');
    // A fake Node: resolves the CLI, records each command and fails the Hermes steps.
    writeFileSync(node, `#!/bin/bash\nif [ "$1" = "-p" ]; then echo /fake/cli.js; exit 0; fi\necho "$2 $3" >> "${record}"\nif [ "$2" = "build" ]; then exit 4; fi\nexit 0\n`);
    chmodSync(node, 0o755);
    const lenient = run(ios, { EVERFRAME_API_TOKEN: 't', SRCROOT: dir, NODE_BINARY: node });
    expect(lenient.status).toBe(0);
    expect(lenient.stdout).toContain('warning: everframe: artifact upload failed (exit status 4)');
    expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['build collect', 'dsym upload-build']);
    expect(run(ios, { EVERFRAME_API_TOKEN: 't', SRCROOT: dir, NODE_BINARY: node, EVERFRAME_SYMBOLS_STRICT: '1' }).status).toBe(4);
  });

  it('gives the uploads a time budget the build can override', () => {
    for (const script of [ios, android])
      expect(script).toContain('export EVERFRAME_UPLOAD_TIMEOUT_SECONDS="${EVERFRAME_UPLOAD_TIMEOUT_SECONDS:-600}"');
  });

  it('uploads dSYMs after the Hermes map on iOS only', () => {
    expect(ios).toContain(`"$EVERFRAME_NODE" "$EVERFRAME_CLI" dsym upload-build --xcode --app-id "${APP}"`);
    expect(ios.indexOf('upload-hermes')).toBeLessThan(ios.indexOf('dsym upload-build'));
    expect(android).not.toContain('dsym upload-build');
  });

  it('reads Android artifacts from the variant the bundle task built', () => {
    expect(android).toContain('"app/build/generated/assets/react/${EVERFRAME_VARIANT:-release}/index.android.bundle"');
    expect(android).toContain('"app/build/generated/sourcemaps/react/${EVERFRAME_VARIANT:-release}/index.android.bundle.map"');
  });

  it('rejects a non-uuid app id', () => {
    expect(() => buildPhaseScript({ platform: 'ios', appId: 'x; rm -rf /', stagingDir: 's', projectRoot: '.' })).toThrow(
      /must be an Everframe application UUID/,
    );
  });
});

describe('patchAppBuildGradle', () => {
  it('inserts one tagged block after the application plugin', () => {
    const out = patchAppBuildGradle(GRADLE, APP);
    expect(out).toContain('// @generated begin everframe-build-artifacts');
    expect(out.indexOf('com.android.application')).toBeLessThan(out.indexOf('@generated begin'));
    expect(out).toContain("new ProcessBuilder('bash', '-c', '''");
  });

  it('is idempotent', () => {
    const once = patchAppBuildGradle(GRADLE, APP);
    expect(patchAppBuildGradle(once, APP)).toBe(once);
  });

  it('replaces the block when the app id changes', () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const out = patchAppBuildGradle(patchAppBuildGradle(GRADLE, APP), other);
    expect(out).toContain(other);
    expect(out).not.toContain(APP);
    expect(out.match(/@generated begin/g)).toHaveLength(1);
  });

  it('passes the bundle task variant to the script', () => {
    const out = patchAppBuildGradle(GRADLE, APP);
    expect(out).toContain('def everframeVariantName = bundleTask.name - "createBundle" - "JsAndAssets"');
    expect(out).toContain("everframeProcess.environment().put('EVERFRAME_VARIANT', everframeVariant)");
  });

  it('reports warning lines as Gradle warnings', () => {
    expect(patchAppBuildGradle(GRADLE, APP)).toContain("if (line.startsWith('warning:')) logger.warn(line) else logger.lifecycle(line)");
  });

  it('fails clearly without the application plugin line', () => {
    expect(() => patchAppBuildGradle('android {}\n', APP)).toThrow(/com\.android\.application/);
  });
});

describe('patchXcodeProject', () => {
  it('adds the phase once and sets SOURCEMAP_FILE on every app configuration', () => {
    const project = loadProject();
    patchXcodeProject(project, APP);
    patchXcodeProject(project, APP);
    const phases = Object.entries(project.hash.project.objects.PBXShellScriptBuildPhase ?? {}).filter(
      ([key, value]) => key.endsWith('_comment') && value === XCODE_PHASE_NAME,
    );
    expect(phases).toHaveLength(1);
    const settings = appBuildSettings(project);
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s.SOURCEMAP_FILE).toBe(SOURCEMAP_FILE_VALUE);
  });

  it('replaces the phase script when the app id changes', () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const project = loadProject();
    patchXcodeProject(project, APP);
    patchXcodeProject(project, other);
    const section = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const keys = Object.keys(section).filter((key) => section[`${key}_comment`] === XCODE_PHASE_NAME);
    expect(keys).toHaveLength(1);
    const script = (section[keys[0]!] as { shellScript: string }).shellScript;
    expect(script).toContain(other);
    expect(script).not.toContain(APP);
  });

  it('orders the RN phase after dSYM generation and runs it every build', () => {
    const project = loadProject();
    patchXcodeProject(project, APP);
    const section = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const key = Object.keys(section).find((k) => section[`${k}_comment`] === XCODE_PHASE_NAME)!;
    const phase = section[key] as { inputPaths: string[]; alwaysOutOfDate: number };
    expect(phase.inputPaths).toEqual(SYMBOLS_PHASE_INPUTS);
    expect(String(phase.alwaysOutOfDate)).toBe('1');
  });

  it('turns off script sandboxing and declares inputs that exist in Debug and Release', () => {
    const project = loadProject();
    patchXcodeProject(project, APP);
    for (const s of appBuildSettings(project)) {
      expect(s.ENABLE_USER_SCRIPT_SANDBOXING).toBe('NO');
      for (const [key, value] of Object.entries(SYMBOLS_BUILD_SETTINGS)) expect(s[key]).toBe(value);
    }
  });

  it('keeps a SOURCEMAP_FILE the app already defines', () => {
    const project = loadProject();
    for (const s of appBuildSettings(project)) s.SOURCEMAP_FILE = '"custom.map"';
    patchXcodeProject(project, APP);
    for (const s of appBuildSettings(project)) expect(s.SOURCEMAP_FILE).toBe('"custom.map"');
  });
});

function appBuildSettings(project: ReturnType<typeof loadProject>): Array<Record<string, string>> {
  const target = project.getFirstTarget().firstTarget as { buildConfigurationList: string };
  const lists = project.pbxXCConfigurationList() as Record<string, { buildConfigurations?: Array<{ value: string }> }>;
  const configs = project.pbxXCBuildConfigurationSection() as Record<string, { buildSettings?: Record<string, string> }>;
  return (lists[target.buildConfigurationList]?.buildConfigurations ?? []).map((ref) => configs[ref.value]!.buildSettings!);
}
