// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { main } from '../src/index.js';
import { DEFAULT_XCODE_UPLOAD_SCRIPT, XCODE_UPLOAD_SCRIPT } from '../src/native-setup/index.js';
import { setupReactNative } from '../src/setup-react-native.js';

const APP = '00000000-0000-4000-8000-000000000000';

async function installCli(dir: string): Promise<void> {
  await mkdir(join(dir, XCODE_UPLOAD_SCRIPT, '..'), { recursive: true });
  await writeFile(join(dir, XCODE_UPLOAD_SCRIPT), '#!/bin/bash\n');
}

async function bareProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'evf-bare-'));
  await mkdir(join(root, 'android', 'app'), { recursive: true });
  await writeFile(
    join(root, 'android', 'app', 'build.gradle'),
    'apply plugin: "com.android.application"\n',
  );
  await mkdir(join(root, 'ios', 'App.xcodeproj'), { recursive: true });
  await cp(
    join(__dirname, 'fixtures/ios/project.pbxproj'),
    join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'),
  );
  return root;
}

describe('setupReactNative', () => {
  it('patches gradle and xcode and prints the metro line', async () => {
    const root = await bareProject();
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toEqual([
      'android/app/build.gradle',
      'ios/App.xcodeproj/project.pbxproj',
    ]);
    expect(await readFile(join(root, 'android/app/build.gradle'), 'utf8')).toContain(
      'everframe-build-artifacts',
    );
    const pbx = await readFile(join(root, 'ios/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain('Upload Everframe Build Artifacts');
    expect(pbx).toContain('SOURCEMAP_FILE');
    expect(result.metroHint).toContain("require('@everframe/metro')");
  });

  it('writes the one-line phase with the standard path when the CLI is installed in the app', async () => {
    const root = await bareProject();
    await installCli(root);
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.uploadScript).toEqual({ path: DEFAULT_XCODE_UPLOAD_SCRIPT, installed: true });
    const pbx = await readFile(join(root, 'ios/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain(
      `shellScript = "/bin/bash \\"\${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh\\" --app-id \\"${APP}\\"";`,
    );
    expect(pbx).not.toContain('EVERFRAME_DSYM_INPUT');
  });

  it('points the phase at a CLI hoisted to the monorepo root', async () => {
    const monorepo = await mkdtemp(join(tmpdir(), 'evf-monorepo-'));
    await installCli(monorepo);
    const root = join(monorepo, 'apps', 'mobile');
    await mkdir(join(root, 'ios', 'App.xcodeproj'), { recursive: true });
    await cp(
      join(__dirname, 'fixtures/ios/project.pbxproj'),
      join(root, 'ios', 'App.xcodeproj', 'project.pbxproj'),
    );
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.uploadScript).toEqual({
      path: '${SRCROOT}/../../../node_modules/@everframe/cli/scripts/xcode-upload.sh',
      installed: true,
    });
    const pbx = await readFile(join(root, 'ios/App.xcodeproj/project.pbxproj'), 'utf8');
    expect(pbx).toContain(
      '/bin/bash \\"${SRCROOT}/../../../node_modules/@everframe/cli/scripts/xcode-upload.sh\\" --app-id',
    );
  });

  it('warns when no installed CLI has the script, and writes the standard path', async () => {
    const root = await bareProject();
    const warnings: string[] = [];
    const warn = vi
      .spyOn(console, 'warn')
      .mockImplementation((line: string) => void warnings.push(line));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await main(['setup', 'react-native', '--project', root, '--app-id', APP], {})).toBe(0);
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
    expect(warnings).toEqual([
      "warning: @everframe/cli is not installed in this app, so the Xcode phase's script ${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh does not exist and every build of the app fails until it does. Install @everframe/cli in the app (npm install --save-dev @everframe/cli) and run this command again.",
    ]);
    expect(await readFile(join(root, 'ios/App.xcodeproj/project.pbxproj'), 'utf8')).toContain(
      '/bin/bash \\"${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh\\" --app-id',
    );
  });

  it('replaces an earlier phase of the same name in place instead of adding a second one', async () => {
    const root = await bareProject();
    await setupReactNative({ projectRoot: root, appId: APP });
    const path = join(root, 'ios/App.xcodeproj/project.pbxproj');
    const fresh = await readFile(path, 'utf8');
    // The earlier, multi-line form of the phase, with its two inputs.
    const earlier = fresh
      .replace(
        /shellScript = "\/bin\/bash \\"\$\{SRCROOT\}[^\n]*\n/,
        'shellScript = "if [ \\"${CONFIGURATION:-}\\" = \\"Debug\\" ]; then exit 0; fi\\nexit 0";\n',
      )
      .replace(
        /inputPaths = \(\n(\t+)"\$\(DWARF_DSYM_FOLDER_PATH\)[^\n]*\n/,
        (_m, indent: string) =>
          `inputPaths = (\n${indent}"$(EVERFRAME_DSYM_INPUT)",\n${indent}"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)",\n`,
      );
    expect(earlier).not.toBe(fresh);
    await writeFile(path, earlier);
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toEqual(['ios/App.xcodeproj/project.pbxproj']);
    const after = await readFile(path, 'utf8');
    expect(after).toBe(fresh);
    expect(after.match(/Upload Everframe Build Artifacts \*\/ = \{/g)).toHaveLength(1);
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
    expect(result.changed).toEqual([
      'android/app/build.gradle',
      'ios/App.xcodeproj/project.pbxproj',
    ]);
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
    await expect(setupReactNative({ projectRoot: root, appId: APP })).rejects.toThrow(
      'no_native_project',
    );
  });

  it('rejects multiple xcode projects without writing anything', async () => {
    const root = await bareProject();
    await mkdir(join(root, 'ios', 'Other.xcodeproj'));
    const gradle = join(root, 'android/app/build.gradle');
    const before = await readFile(gradle, 'utf8');
    const mtime = (await stat(gradle)).mtimeMs;
    await expect(setupReactNative({ projectRoot: root, appId: APP })).rejects.toThrow(
      'multiple_xcode_projects',
    );
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
    await writeFile(
      join(root, 'android', 'build.gradle'),
      "buildscript {\n  dependencies {\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n",
    );
    const result = await setupReactNative({ projectRoot: root, appId: APP });
    expect(result.changed).toContain('android/build.gradle');
    expect(await readFile(join(root, 'android/build.gradle'), 'utf8')).toContain(
      'dev.everframe:gradle-plugin:',
    );
  });

  it('reports every file it patched, changed or not', async () => {
    const root = await bareProject();
    await writeFile(
      join(root, 'android', 'build.gradle'),
      "buildscript {\n  dependencies {\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n",
    );
    const first = await setupReactNative({ projectRoot: root, appId: APP });
    expect(first.files).toEqual([
      { path: 'android/app/build.gradle', changed: true },
      { path: 'android/build.gradle', changed: true },
      { path: 'ios/App.xcodeproj/project.pbxproj', changed: true },
    ]);
    // Only the app file differs when the app id changes; the root file is still listed.
    const lines: string[] = [];
    const log = vi
      .spyOn(console, 'log')
      .mockImplementation((line: string) => void lines.push(line));
    try {
      expect(
        await main(
          [
            'setup',
            'react-native',
            '--project',
            root,
            '--app-id',
            '11111111-1111-4111-8111-111111111111',
          ],
          {},
        ),
      ).toBe(0);
    } finally {
      log.mockRestore();
    }
    expect(lines.slice(0, 3)).toEqual([
      'Updated android/app/build.gradle',
      'No changes: android/build.gradle',
      'Updated ios/App.xcodeproj/project.pbxproj',
    ]);
  });
});
