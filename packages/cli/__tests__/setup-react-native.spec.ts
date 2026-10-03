// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
});
