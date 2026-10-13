// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCEMAP_FILE_VALUE } from '@everframe/cli/native-setup';
import { describe, expect, it } from 'vitest';
import { applyAndroid, applyAndroidProject, applyIos } from '../src/withEverframe.js';

const APP = '00000000-0000-4000-8000-000000000000';

describe('@everframe/expo', () => {
  it('adds only the Gradle plugin and the app id to the app build.gradle', () => {
    const out = applyAndroid({ language: 'groovy', contents: 'apply plugin: "com.android.application"\n' }, APP);
    expect(out.contents).toBe(
      [
        'apply plugin: "com.android.application"',
        '// @generated begin everframe-build-artifacts',
        'apply plugin: "dev.everframe"',
        `everframe { appId = "${APP}" }`,
        '// @generated end everframe-build-artifacts',
        '',
      ].join('\n'),
    );
    expect(applyAndroid(out, APP)).toEqual(out);
  });

  it('rejects kotlin build scripts', () => {
    expect(() => applyAndroid({ language: 'kt', contents: '' }, APP)).toThrow(/Groovy/);
  });

  /** A fake `xcode` project that records the phases and settings the patcher writes. */
  const fakeProject = () => {
    const phases: Array<{ name: string; shellScript: string; inputPaths?: string[] }> = [];
    const settings: Record<string, string> = {};
    const project = {
      pbxItemByComment: () => undefined,
      getFirstTarget: () => ({ uuid: 'T', firstTarget: { buildConfigurationList: 'L' } }),
      addBuildPhase: (_f: string[], _t: string, name: string, _target: string, options: { shellScript: string; inputPaths?: string[] }) => {
        phases.push({ name, ...options });
      },
      pbxXCConfigurationList: () => ({ L: { buildConfigurations: [{ value: 'C' }] } }),
      pbxXCBuildConfigurationSection: () => ({ C: { buildSettings: settings } }),
    };
    return { project, phases, settings };
  };
  /** An app root with `ios/`, and `@everframe/cli`'s upload script installed under `cliRoot`. */
  const appWithCli = (cliRoot: (root: string) => string) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'everframe-expo-')));
    const scripts = join(cliRoot(root), 'node_modules/@everframe/cli/scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'xcode-upload.sh'), '#!/bin/bash\n');
    return root;
  };

  it('adds the one-line upload phase and two settings to the xcode project', () => {
    const { project, phases, settings } = fakeProject();
    const root = appWithCli((r) => r);
    applyIos(project, APP, join(root, 'ios'));
    expect(phases).toEqual([
      {
        name: 'Upload Everframe Build Artifacts',
        shellPath: '/bin/bash',
        shellScript: `/bin/bash "\${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh" --app-id "${APP}"`,
        inputPaths: ['"$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(EXECUTABLE_NAME)"'],
      },
    ]);
    expect(settings).toEqual({ SOURCEMAP_FILE: SOURCEMAP_FILE_VALUE, ENABLE_USER_SCRIPT_SANDBOXING: 'NO' });
  });

  it('points the phase at a CLI hoisted to the monorepo root', () => {
    const { project, phases } = fakeProject();
    const monorepo = appWithCli((r) => r);
    const app = join(monorepo, 'apps/mobile');
    mkdirSync(join(app, 'ios'), { recursive: true });
    applyIos(project, APP, join(app, 'ios'));
    expect(phases[0]!.shellScript).toBe(
      `/bin/bash "\${SRCROOT}/../../../node_modules/@everframe/cli/scripts/xcode-upload.sh" --app-id "${APP}"`,
    );
  });

  it('falls back to the standard path without an installed CLI', () => {
    const { project, phases } = fakeProject();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'everframe-expo-')));
    applyIos(project, APP, join(root, 'ios'));
    expect(phases[0]!.shellScript).toBe(`/bin/bash "\${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh" --app-id "${APP}"`);
  });

  it('runs the patcher from the prebuild ios folder', async () => {
    const { withEverframe } = await import('../src/withEverframe.js');
    const monorepo = appWithCli((r) => r);
    const app = join(monorepo, 'apps/mobile');
    mkdirSync(join(app, 'ios'), { recursive: true });
    const { project, phases } = fakeProject();
    type Mod = { modResults: unknown; modRequest: { platformProjectRoot: string } };
    type Config = { mods?: { ios?: { xcodeproj?: (mod: Mod) => Promise<Mod> | Mod } } };
    const config = withEverframe({ name: 'app', slug: 'app' }, { appId: APP }) as unknown as Config;
    const mod = config.mods?.ios?.xcodeproj;
    expect(mod).toBeTypeOf('function');
    await mod!({ modResults: project, modRequest: { platformProjectRoot: join(app, 'ios') } });
    expect(phases[0]!.shellScript).toContain('/bin/bash "${SRCROOT}/../../../node_modules/@everframe/cli/scripts/xcode-upload.sh"');
  });

  it('adds the Everframe Gradle plugin classpath to the project build.gradle', () => {
    const out = applyAndroidProject({ language: 'groovy', contents: "buildscript {\n  dependencies {\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n" });
    expect(out.contents).toContain('dev.everframe:gradle-plugin:');
  });
});
