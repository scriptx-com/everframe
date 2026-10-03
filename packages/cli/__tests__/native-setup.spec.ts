// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import xcode from 'xcode';
import {
  buildPhaseScript,
  patchAppBuildGradle,
  patchXcodeProject,
  SOURCEMAP_FILE_VALUE,
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
