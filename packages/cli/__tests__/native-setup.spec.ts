// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import xcode from 'xcode';
import {
  EVERFRAME_GRADLE_PLUGIN,
  patchAppBuildGradle,
  patchRootBuildGradle,
  patchXcodeProject,
  SOURCEMAP_FILE_VALUE,
  SYMBOLS_BUILD_SETTINGS,
  SYMBOLS_PHASE_INPUTS,
  XCODE_PHASE_NAME,
  xcodePhaseScript,
} from '../src/native-setup/index.js';

const APP = '00000000-0000-4000-8000-000000000000';
const GRADLE = "apply plugin: \"com.android.application\"\n\nandroid {\n}\n";
const loadProject = () => {
  const project = xcode.project(join(__dirname, 'fixtures/ios/project.pbxproj'));
  project.parseSync();
  return project;
};

const THIN_GRADLE = [
  '// @generated begin everframe-build-artifacts',
  'apply plugin: "dev.everframe"',
  `everframe { appId = "${APP}" }`,
  '// @generated end everframe-build-artifacts',
].join('\n');

describe('xcodePhaseScript', () => {
  const script = xcodePhaseScript(APP);
  const run = (env: Record<string, string>) =>
    spawnSync('bash', ['-c', script], { env: { PATH: process.env.PATH!, ...env }, encoding: 'utf8' });
  /** An app root with ios/ and a fake Node that resolves the CLI and records how it was run. */
  const app = (resolves: boolean) => {
    const root = mkdtempSync(join(tmpdir(), 'everframe-phase-'));
    mkdirSync(join(root, 'ios'));
    const node = join(root, 'node');
    writeFileSync(
      node,
      `#!/bin/bash\nif [ "$1" = "--print" ]; then ${resolves ? `pwd -P > "${root}/cwd"; echo /fake/cli.js; exit 0` : 'echo "Error: Cannot find module" >&2; exit 1'}; fi\necho "$@" > "${root}/args"\nexit 7\n`,
    );
    chmodSync(node, 0o755);
    return { root, node, srcroot: join(root, 'ios') };
  };

  it('is six lines that hand the work to `everframe xcode build-phase`', () => {
    expect(script.split('\n')).toHaveLength(6);
    expect(script).toContain(`"\${NODE_BINARY:-node}" "$EVERFRAME_CLI_JS" xcode build-phase --app-id "${APP}"`);
    expect(script).not.toContain('exec ');
    expect(script).not.toContain('EVERFRAME_API_TOKEN');
    expect(script).not.toContain('upload-hermes');
  });

  it('resolves the CLI with Node from the app root and runs it', () => {
    const { root, node, srcroot } = app(true);
    expect(run({ SRCROOT: srcroot, NODE_BINARY: node, EVERFRAME_SYMBOLS_STRICT: '1' }).status).toBe(7);
    expect(readFileSync(join(root, 'args'), 'utf8').trim()).toBe(`/fake/cli.js xcode build-phase --app-id ${APP}`);
    expect(readFileSync(join(root, 'cwd'), 'utf8').trim()).toBe(realpathSync(root));
  });

  it("takes NODE_BINARY from the project's .xcode.env files", () => {
    const { root, node, srcroot } = app(true);
    writeFileSync(join(srcroot, '.xcode.env'), 'export NODE_BINARY=/nonexistent/node\n');
    writeFileSync(join(srcroot, '.xcode.env.local'), `export NODE_BINARY="${node}"\n`);
    expect(run({ SRCROOT: srcroot, EVERFRAME_SYMBOLS_STRICT: '1' }).status).toBe(7);
    expect(readFileSync(join(root, 'args'), 'utf8')).toContain('xcode build-phase');
  });

  it('warns and continues when Node or the CLI is missing, and fails when strict', () => {
    const { node, srcroot } = app(false);
    for (const env of [{ NODE_BINARY: node }, { NODE_BINARY: '/nonexistent/node' }]) {
      const lenient = run({ SRCROOT: srcroot, ...env });
      expect(lenient.status).toBe(0);
      expect(lenient.stdout).toContain('warning: everframe: could not run @everframe/cli with Node');
      expect(lenient.stderr).not.toContain('Cannot find module');
    }
    expect(run({ SRCROOT: srcroot, NODE_BINARY: node, EVERFRAME_SYMBOLS_STRICT: '1' }).status).toBe(1);
    expect(run({ SRCROOT: srcroot, NODE_BINARY: node, EVERFRAME_SYMBOLS_STRICT: 'true' }).status).toBe(1);
  });

  it('warns and continues when an incomplete install makes the CLI fail before it runs, and fails when strict', () => {
    // A real Node and an installed @everframe/cli whose own dependency is missing.
    const root = mkdtempSync(join(tmpdir(), 'everframe-broken-cli-'));
    mkdirSync(join(root, 'ios'));
    const cli = join(root, 'node_modules/@everframe/cli');
    mkdirSync(join(cli, 'dist'), { recursive: true });
    writeFileSync(join(cli, 'package.json'), JSON.stringify({ name: '@everframe/cli', main: 'dist/index.js' }));
    writeFileSync(join(cli, 'dist/index.js'), "require('everframe-missing-dependency');\n");
    const env = { SRCROOT: join(root, 'ios'), NODE_BINARY: process.execPath, CONFIGURATION: 'Release' };
    const lenient = run(env);
    expect(lenient.status).toBe(0);
    expect(lenient.stderr).toContain('everframe-missing-dependency');
    expect(lenient.stdout).toContain('warning: everframe: could not run @everframe/cli with Node from');
    expect(lenient.stdout).toContain('(exit status 1); build artifacts were not uploaded and the build continues.');
    const strict = run({ ...env, EVERFRAME_SYMBOLS_STRICT: '1' });
    expect(strict.status).toBe(1);
    expect(strict.stdout).not.toContain('warning:');
  });

  it.each([{ CONFIGURATION: 'Debug' }, { SKIP_BUNDLING: '1' }])('skips %o before Node, even when strict and Node is missing', (env) => {
    const result = run({ ...env, SRCROOT: '/nonexistent/ios', NODE_BINARY: '/nonexistent/node', EVERFRAME_SYMBOLS_STRICT: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('everframe: Debug build, skipping artifact upload');
    expect(result.stderr).not.toContain('nonexistent');
  });

  it('rejects a non-uuid app id', () => {
    expect(() => xcodePhaseScript('x"; rm -rf /')).toThrow(/must be an Everframe application UUID/);
  });
});

describe('patchAppBuildGradle', () => {
  it('inserts the plugin and app id after the application plugin, nothing else', () => {
    expect(patchAppBuildGradle(GRADLE, APP)).toBe(`apply plugin: "com.android.application"\n${THIN_GRADLE}\n\nandroid {\n}\n`);
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

  it('writes the short script', () => {
    const project = loadProject();
    patchXcodeProject(project, APP);
    expect(phaseScripts(project)).toEqual([`"${xcodePhaseScript(APP).replace(/"/g, '\\"')}"`]);
  });

  it('keeps a SOURCEMAP_FILE the app already defines', () => {
    const project = loadProject();
    for (const s of appBuildSettings(project)) s.SOURCEMAP_FILE = '"custom.map"';
    patchXcodeProject(project, APP);
    for (const s of appBuildSettings(project)) expect(s.SOURCEMAP_FILE).toBe('"custom.map"');
  });
});

function phaseScripts(project: ReturnType<typeof loadProject>): string[] {
  const section = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
  return Object.keys(section)
    .filter((key) => section[`${key}_comment`] === XCODE_PHASE_NAME)
    .map((key) => (section[key] as { shellScript: string }).shellScript);
}

function appBuildSettings(project: ReturnType<typeof loadProject>): Array<Record<string, string>> {
  const target = project.getFirstTarget().firstTarget as { buildConfigurationList: string };
  const lists = project.pbxXCConfigurationList() as Record<string, { buildConfigurations?: Array<{ value: string }> }>;
  const configs = project.pbxXCBuildConfigurationSection() as Record<string, { buildSettings?: Record<string, string> }>;
  return (lists[target.buildConfigurationList]?.buildConfigurations ?? []).map((ref) => configs[ref.value]!.buildSettings!);
}

describe('patchRootBuildGradle', () => {
  const ROOT = "buildscript {\n  dependencies {\n    classpath('com.android.tools.build:gradle')\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n";
  it('adds the pinned Everframe Gradle plugin after the React Native plugin classpath, once', () => {
    const out = patchRootBuildGradle(ROOT);
    expect(out).toContain(`    classpath("${EVERFRAME_GRADLE_PLUGIN}")`);
    expect(out.indexOf('react-native-gradle-plugin')).toBeLessThan(out.indexOf('dev.everframe:gradle-plugin'));
    expect(patchRootBuildGradle(out)).toBe(out);
  });
  it('pins the Gradle plugin released with this CLI, on the shared version line', () => {
    const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string };
    const properties = readFileSync(join(__dirname, '../../sdk-android/android/gradle.properties'), 'utf8');
    expect(EVERFRAME_GRADLE_PLUGIN).toBe(`dev.everframe:gradle-plugin:${version}`);
    expect(/^everframeVersion=(.+)$/m.exec(properties)![1]!.trim()).toBe(version);
  });
  it('moves an existing classpath block to this version in place', () => {
    const current = patchRootBuildGradle(ROOT);
    const older = current.replace(EVERFRAME_GRADLE_PLUGIN, 'dev.everframe:gradle-plugin:0.0.1');
    expect(older).not.toBe(current);
    expect(patchRootBuildGradle(older)).toBe(current);
  });
  it('fails clearly without the React Native classpath line', () => {
    expect(() => patchRootBuildGradle('buildscript {}\n')).toThrow(/react-native-gradle-plugin/);
  });
});
