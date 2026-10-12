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

const LEGACY = join(__dirname, 'fixtures/legacy-build-artifacts');
const LEGACY_APP = '00000000-0000-4000-8000-0000000000aa';
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

  it('replaces the long block earlier versions generated, and leaves the rest of the file alone', () => {
    const legacy = readFileSync(join(LEGACY, 'app.build.gradle'), 'utf8');
    const begin = legacy.indexOf('// @generated begin everframe-build-artifacts');
    const endMarker = '// @generated end everframe-build-artifacts';
    const end = legacy.indexOf(endMarker) + endMarker.length;
    expect(legacy.slice(begin, end).split('\n')).toHaveLength(47);
    const out = patchAppBuildGradle(legacy, APP);
    expect(out).toBe(legacy.slice(0, begin) + THIN_GRADLE + legacy.slice(end));
    expect(out).not.toContain('ProcessBuilder');
    expect(out).not.toContain('afterEvaluate {\n  def everframe');
    for (const token of ['{{CLIENT_ID}}', '{{VERSION_CODE}}', '{{VERSION_NAME}}']) expect(out).toContain(token);
    expect(patchAppBuildGradle(out, APP)).toBe(out);
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

  it('replaces the long phase earlier versions generated, keeping placeholders and settings', () => {
    const path = join(LEGACY, 'project.pbxproj');
    const legacy = readFileSync(path, 'utf8');
    expect(legacy).toContain('build collect --staging');
    const project = xcode.project(path);
    project.parseSync();
    patchXcodeProject(project, LEGACY_APP);
    const out: string = project.writeSync();
    expect(phaseScripts(project)).toEqual([`"${xcodePhaseScript(LEGACY_APP).replace(/"/g, '\\"')}"`]);
    expect(out).not.toContain('build collect');
    expect(out).not.toContain('dsym upload-build');
    expect(out.match(/Upload Everframe Build Artifacts \*\/,/g)).toHaveLength(1);
    for (const token of ['{{TITLE}}', '{{CLIENT_ID}}', '{{DEVELOPMENT_TEAM}}']) expect(out.split(token).length).toBe(legacy.split(token).length);
    // Only the phase script changed: the settings the old version wrote are already right.
    const script = `\t\t\tshellScript = "${xcodePhaseScript(LEGACY_APP).replace(/"/g, '\\"')}";\n`;
    const expected = legacy.replace(/\t\t\tshellScript = "set -euo pipefail\n[\s\S]*?\nexit 0";\n/, () => script);
    expect(expected).not.toBe(legacy);
    expect(out).toBe(expected);
    const again = xcode.project(path);
    again.parseSync();
    patchXcodeProject(again, LEGACY_APP);
    patchXcodeProject(again, LEGACY_APP);
    expect(again.writeSync()).toBe(expected);
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
  it('pins the Android SDK version this repository publishes', () => {
    const properties = readFileSync(join(__dirname, '../../sdk-android/android/gradle.properties'), 'utf8');
    expect(EVERFRAME_GRADLE_PLUGIN).toBe(`dev.everframe:gradle-plugin:${/^everframeVersion=(.+)$/m.exec(properties)![1]!.trim()}`);
  });
  it('keeps the classpath block of an earlier version in place and moves it to this version', () => {
    const legacy = readFileSync(join(LEGACY, 'build.gradle'), 'utf8');
    expect(legacy).toContain('classpath("dev.everframe:gradle-plugin:1.2.0")');
    const out = patchRootBuildGradle(legacy);
    expect(out).toBe(legacy.replace('dev.everframe:gradle-plugin:1.2.0', EVERFRAME_GRADLE_PLUGIN.replace('$', '$$$$')));
    expect(out).toContain('{{ENV INJECTION}}');
    expect(patchRootBuildGradle(out)).toBe(out);
  });
  it('fails clearly without the React Native classpath line', () => {
    expect(() => patchRootBuildGradle('buildscript {}\n')).toThrow(/react-native-gradle-plugin/);
  });
});
