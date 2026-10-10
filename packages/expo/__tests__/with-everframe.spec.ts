// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { SOURCEMAP_FILE_VALUE } from '@everframe/cli/native-setup';
import { describe, expect, it } from 'vitest';
import { applyAndroid, applyAndroidProject, applyIos } from '../src/withEverframe.js';

const APP = '00000000-0000-4000-8000-000000000000';

describe('@everframe/expo', () => {
  it('patches groovy build.gradle through the shared cli patcher', () => {
    const out = applyAndroid({ language: 'groovy', contents: 'apply plugin: "com.android.application"\n' }, APP);
    expect(out.contents).toContain('@generated begin everframe-build-artifacts');
  });

  it('rejects kotlin build scripts', () => {
    expect(() => applyAndroid({ language: 'kt', contents: '' }, APP)).toThrow(/Groovy/);
  });

  it('passes the xcode project to the shared patcher', () => {
    const calls: string[] = [];
    const settings: Record<string, string> = {};
    const project = {
      pbxItemByComment: () => undefined,
      getFirstTarget: () => ({ uuid: 'T', firstTarget: { buildConfigurationList: 'L' } }),
      addBuildPhase: (_f: string[], _t: string, name: string) => calls.push(name),
      pbxXCConfigurationList: () => ({ L: { buildConfigurations: [{ value: 'C' }] } }),
      pbxXCBuildConfigurationSection: () => ({ C: { buildSettings: settings } }),
    };
    applyIos(project, APP);
    expect(calls).toEqual(['Upload Everframe Build Artifacts']);
    expect(settings.SOURCEMAP_FILE).toBe(SOURCEMAP_FILE_VALUE);
  });

  it('adds the Everframe Gradle plugin classpath to the project build.gradle', () => {
    const out = applyAndroidProject({ language: 'groovy', contents: "buildscript {\n  dependencies {\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n" });
    expect(out.contents).toContain('dev.everframe:gradle-plugin:');
  });
});
