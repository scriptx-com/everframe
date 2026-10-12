// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setupReactNative } from '../src/setup-react-native.js';

const APP = '00000000-0000-4000-8000-000000000000';

async function bareProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evf-bare-'));
  await mkdir(join(root, 'android', 'app'), { recursive: true });
  await writeFile(join(root, 'android', 'app', 'build.gradle'), 'apply plugin: "com.android.application"\n');
  await mkdir(join(root, 'ios', 'App.xcodeproj'), { recursive: true });
  await cp(join(__dirname, 'fixtures/ios/project.pbxproj'), join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'));
  return root;
}

describe('setupReactNative', () => {
  it('patches gradle and xcode and prints the metro line', async () => {
    const root = await bareProject();
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toEqual(['android/app/build.gradle', 'ios/App.xcodeproj/project.pbxproj']);
    expect(await readFile(join(root, 'android/app/build.gradle'), 'utf8')).toContain('everframe-build-artifacts');
    const pbx = await readFile(join(root, 'ios/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain('Upload Everframe Build Artifacts');
    expect(pbx).toContain('SOURCEMAP_FILE');
    expect(result.metroHint).toContain("require('@everframe/metro')");
  });

  it('is a no-op the second time', async () => {
    const root = await bareProject();
    await setupReactNative({ projectRoot: root, appId: APP });
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toEqual([]);
  });

  it('rejects a kotlin gradle script with the groovy message', async () => {
    const root = await bareProject();
    await writeFile(join(root, 'android/app/build.gradle.kts'), '');
    await rm(join(root, 'android/app/build.gradle'));
    await expect(setupReactNative({ projectRoot: root, appId: APP })).rejects.toThrow(/Groovy/);
  });

  it('rejects a non-uuid app id before touching files', async () => {
    const root = await bareProject();
    const before = await readFile(join(root, 'android/app/build.gradle'), 'utf8');
    await expect(setupReactNative({ projectRoot: root, appId: 'nope' })).rejects.toThrow(/UUID/);
    expect(await readFile(join(root, 'android/app/build.gradle'), 'utf8')).toBe(before);
  });

  it('rewrites the xcode phase when re-run with a new app id', async () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const root = await bareProject();
    await setupReactNative({ projectRoot: root, appId: APP });
    const result = await setupReactNative({ projectRoot: root, appId: other });
    expect(result.changed).toEqual(['android/app/build.gradle', 'ios/App.xcodeproj/project.pbxproj']);
    const pbx = await readFile(join(root, 'ios/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain(other);
    expect(pbx).not.toContain(APP);
    expect(pbx.match(/Upload Everframe Build Artifacts \*\/ = \{/g)).toHaveLength(1);
  });

  it('patches an android-only project', async () => {
    const root = await bareProject();
    await rm(join(root, 'ios'), { recursive: true });
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toEqual(['android/app/build.gradle']);
  });

  it('patches an ios-only project', async () => {
    const root = await bareProject();
    await rm(join(root, 'android'), { recursive: true });
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toEqual(['ios/App.xcodeproj/project.pbxproj']);
  });

  it('fails without any native project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'evf-bare-'));
    await expect(setupReactNative({ projectRoot: root, appId: APP })).rejects.toThrow('no_native_project');
  });

  it('rejects multiple xcode projects without writing anything', async () => {
    const root = await bareProject();
    await mkdir(join(root, 'ios', 'Other.xcodeproj'));
    const gradle = join(root, 'android/app/build.gradle');
    const before = await readFile(gradle, 'utf8');
    const mtime = (await stat(gradle)).mtimeMs;
    await expect(setupReactNative({ projectRoot: root, appId: APP })).rejects.toThrow('multiple_xcode_projects');
    expect(await readFile(gradle, 'utf8')).toBe(before);
    expect((await stat(gradle)).mtimeMs).toBe(mtime);
  });

  it('rejects a kotlin gradle script before patching xcode', async () => {
    const root = await bareProject();
    await rm(join(root, 'android/app/build.gradle'));
    await writeFile(join(root, 'android/app/build.gradle.kts'), '');
    const pbx = join(root, 'ios/App.xcodeproj/project.pbxproj');
    const before = await readFile(pbx, 'utf8');
    await expect(setupReactNative({ projectRoot: root, appId: APP })).rejects.toThrow(/Groovy/);
    expect(await readFile(pbx, 'utf8')).toBe(before);
  });

  it('adds the Everframe Gradle plugin classpath to android/build.gradle', async () => {
    const root = await bareProject();
    await writeFile(join(root, 'android', 'build.gradle'), "buildscript {\n  dependencies {\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n");
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toContain('android/build.gradle');
    expect(await readFile(join(root, 'android/build.gradle'), 'utf8')).toContain('dev.everframe:gradle-plugin:');
  });
});
