// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import xcode from 'xcode';
import { androidVersionFrom, buildConstants } from '../build-constants';
import {
  DEFAULT_XCODE_UPLOAD_SCRIPT,
  EVERFRAME_GRADLE_PLUGIN,
  patchAppBuildGradle,
  patchRootBuildGradle,
  patchXcodeProject,
  SOURCEMAP_FILE_VALUE,
  SYMBOLS_BUILD_SETTINGS,
  SYMBOLS_PHASE_INPUTS,
  XCODE_PHASE_NAME,
  xcodePhaseScript,
  xcodeUploadScriptPath,
} from '../src/native-setup/index.js';

const APP = '00000000-0000-4000-8000-000000000000';
const GRADLE = 'apply plugin: "com.android.application"\n\nandroid {\n}\n';
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

const ONE_LINE = `/bin/bash "\${SRCROOT}/../node_modules/@everframe/cli/scripts/xcode-upload.sh" --app-id "${APP}"`;
const DSYM_INPUT =
  '"$(DWARF_DSYM_FOLDER_PATH)/$(DWARF_DSYM_FILE_NAME)/Contents/Resources/DWARF/$(EXECUTABLE_NAME)"';

describe('xcodePhaseScript', () => {
  it('is one line that runs the upload script shipped in @everframe/cli', () => {
    expect(xcodePhaseScript(APP)).toBe(ONE_LINE);
    expect(xcodePhaseScript(APP, DEFAULT_XCODE_UPLOAD_SCRIPT)).toBe(ONE_LINE);
  });

  it('takes a hoisted script path', () => {
    const hoisted = '${SRCROOT}/../../../node_modules/@everframe/cli/scripts/xcode-upload.sh';
    expect(xcodePhaseScript(APP, hoisted)).toBe(`/bin/bash "${hoisted}" --app-id "${APP}"`);
  });

  it.each([
    '/abs/node_modules/@everframe/cli/scripts/xcode-upload.sh',
    '${SRCROOT}/node_modules/@everframe/cli/scripts/xcode-upload.sh',
    '${SRCROOT}/../x"; rm -rf /; "/node_modules/@everframe/cli/scripts/xcode-upload.sh',
    '${SRCROOT}/../node_modules/@everframe/cli/scripts/other.sh',
  ])('rejects any other script path: %s', (path) => {
    expect(() => xcodePhaseScript(APP, path)).toThrow(/invalid_upload_script_path/);
  });

  it('rejects a non-uuid app id', () => {
    expect(() => xcodePhaseScript('x"; rm -rf /')).toThrow(/must be an Everframe application UUID/);
  });
});

describe('xcodeUploadScriptPath', () => {
  /** Installs a package folder with the script at `dir/node_modules/@everframe/cli`. */
  const install = (dir: string) => {
    const scripts = join(dir, 'node_modules/@everframe/cli/scripts');
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, 'xcode-upload.sh'), '#!/bin/bash\n');
  };
  const tree = () => realpathSync(mkdtempSync(join(tmpdir(), 'everframe-script-path-')));

  it('finds the CLI in the app root', () => {
    const root = tree();
    install(root);
    expect(xcodeUploadScriptPath(join(root, 'ios'))).toEqual({
      path: DEFAULT_XCODE_UPLOAD_SCRIPT,
      installed: true,
    });
  });

  it('finds a CLI hoisted to a monorepo root, and prefers the nearest one', () => {
    const root = tree();
    install(root);
    const app = join(root, 'apps/mobile');
    mkdirSync(join(app, 'ios'), { recursive: true });
    expect(xcodeUploadScriptPath(join(app, 'ios'))).toEqual({
      path: '${SRCROOT}/../../../node_modules/@everframe/cli/scripts/xcode-upload.sh',
      installed: true,
    });
    install(app);
    expect(xcodeUploadScriptPath(join(app, 'ios')).path).toBe(DEFAULT_XCODE_UPLOAD_SCRIPT);
  });

  it('keeps a pnpm symlink instead of the versioned store path behind it', () => {
    const root = tree();
    const store = join(root, 'node_modules/.pnpm/@everframe+cli@9.9.9/node_modules/@everframe/cli');
    mkdirSync(join(store, 'scripts'), { recursive: true });
    writeFileSync(join(store, 'scripts/xcode-upload.sh'), '#!/bin/bash\n');
    mkdirSync(join(root, 'node_modules/@everframe'));
    symlinkSync(
      '../.pnpm/@everframe+cli@9.9.9/node_modules/@everframe/cli',
      join(root, 'node_modules/@everframe/cli'),
    );
    expect(xcodeUploadScriptPath(join(root, 'ios'))).toEqual({
      path: DEFAULT_XCODE_UPLOAD_SCRIPT,
      installed: true,
    });
  });

  it('skips an installed CLI without the script and falls back to the standard path', () => {
    const root = tree();
    mkdirSync(join(root, 'node_modules/@everframe/cli/dist'), { recursive: true });
    expect(xcodeUploadScriptPath(join(root, 'ios'))).toEqual({
      path: DEFAULT_XCODE_UPLOAD_SCRIPT,
      installed: false,
    });
  });

  it('returns a path xcodePhaseScript accepts', () => {
    const root = tree();
    install(root);
    const deep = join(root, 'a/b/c');
    mkdirSync(join(deep, 'ios'), { recursive: true });
    expect(() =>
      xcodePhaseScript(APP, xcodeUploadScriptPath(join(deep, 'ios')).path),
    ).not.toThrow();
  });
});

describe('patchAppBuildGradle', () => {
  it('inserts the plugin and app id after the application plugin, nothing else', () => {
    expect(patchAppBuildGradle(GRADLE, APP)).toBe(
      `apply plugin: "com.android.application"\n${THIN_GRADLE}\n\nandroid {\n}\n`,
    );
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
    const phases = Object.entries(
      project.hash.project.objects.PBXShellScriptBuildPhase ?? {},
    ).filter(([key, value]) => key.endsWith('_comment') && value === XCODE_PHASE_NAME);
    expect(phases).toHaveLength(1);
    const settings = appBuildSettings(project);
    expect(settings.length).toBeGreaterThan(0);
    for (const s of settings) expect(s.SOURCEMAP_FILE).toBe(SOURCEMAP_FILE_VALUE);
  });

  it('writes exactly the one-line phase, the dSYM input and two settings', () => {
    const before = readFileSync(join(__dirname, 'fixtures/ios/project.pbxproj'), 'utf8');
    const project = loadProject();
    patchXcodeProject(project, APP);
    const after: string = project.writeSync();
    const id = /\t([0-9A-F]{24}) \/\* Upload Everframe Build Artifacts \*\/,\n/.exec(after)![1];
    const reference = `\t\t\t\t${id} /* Upload Everframe Build Artifacts */,\n`;
    const phase = [
      `\t\t${id} /* Upload Everframe Build Artifacts */ = {`,
      '\t\t\tisa = PBXShellScriptBuildPhase;',
      '\t\t\tbuildActionMask = 2147483647;',
      '\t\t\tfiles = (',
      '\t\t\t);',
      '\t\t\trunOnlyForDeploymentPostprocessing = 0;',
      '\t\t\tname = "Upload Everframe Build Artifacts";',
      '\t\t\tinputPaths = (',
      `\t\t\t\t${DSYM_INPUT},`,
      '\t\t\t);',
      '\t\t\toutputPaths = (',
      '\t\t\t);',
      '\t\t\tshellPath = /bin/bash;',
      `\t\t\tshellScript = "${ONE_LINE.replace(/"/g, '\\"')}";`,
      '\t\t\talwaysOutOfDate = 1;',
      '\t\t};',
      '',
    ].join('\n');
    const settings =
      '\t\t\t\tSOURCEMAP_FILE = "$(DERIVED_FILE_DIR)/main.jsbundle.map";\n\t\t\t\tENABLE_USER_SCRIPT_SANDBOXING = NO;\n';
    expect(after).toContain(reference);
    expect(after).toContain(phase);
    expect(after.split(settings)).toHaveLength(3); // Debug and Release
    expect(after.replace(reference, '').replace(phase, '').split(settings).join('')).toBe(before);
    // One reference, the 16-line phase and two settings in each of the two configurations.
    expect(after.split('\n').length - before.split('\n').length).toBe(21);
    expect(after).not.toContain('EVERFRAME_DSYM_INPUT');
  });

  it('replaces the phase script when the app id changes', () => {
    const other = '11111111-1111-4111-8111-111111111111';
    const project = loadProject();
    patchXcodeProject(project, APP);
    patchXcodeProject(project, other);
    const section = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const keys = Object.keys(section).filter(
      (key) => section[`${key}_comment`] === XCODE_PHASE_NAME,
    );
    expect(keys).toHaveLength(1);
    const script = (section[keys[0]!] as { shellScript: string }).shellScript;
    expect(script).toContain(other);
    expect(script).not.toContain(APP);
  });

  it('rewrites an earlier phase of the same name in place instead of adding a second one', () => {
    const project = loadProject();
    project.addBuildPhase(
      [],
      'PBXShellScriptBuildPhase',
      XCODE_PHASE_NAME,
      project.getFirstTarget().uuid,
      {
        shellPath: '/bin/bash',
        shellScript: 'echo one\necho two\necho three',
        inputPaths: ['"$(EVERFRAME_DSYM_INPUT)"', '"$(TARGET_BUILD_DIR)/$(INFOPLIST_PATH)"'],
      },
    );
    patchXcodeProject(
      project,
      APP,
      '${SRCROOT}/../../node_modules/@everframe/cli/scripts/xcode-upload.sh',
    );
    expect(phaseScripts(project)).toEqual([
      `"/bin/bash \\"\${SRCROOT}/../../node_modules/@everframe/cli/scripts/xcode-upload.sh\\" --app-id \\"${APP}\\""`,
    ]);
    const section = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const key = Object.keys(section).find((k) => section[`${k}_comment`] === XCODE_PHASE_NAME)!;
    expect((section[key] as { inputPaths: string[] }).inputPaths).toEqual([DSYM_INPUT]);
  });

  it('orders the phase after dSYM generation and runs it every build', () => {
    const project = loadProject();
    patchXcodeProject(project, APP);
    const section = project.hash.project.objects.PBXShellScriptBuildPhase ?? {};
    const key = Object.keys(section).find((k) => section[`${k}_comment`] === XCODE_PHASE_NAME)!;
    const phase = section[key] as { inputPaths: string[]; alwaysOutOfDate: number };
    expect(phase.inputPaths).toEqual([DSYM_INPUT]);
    expect(SYMBOLS_PHASE_INPUTS).toEqual([DSYM_INPUT]);
    expect(String(phase.alwaysOutOfDate)).toBe('1');
  });

  it('turns off script sandboxing and writes no other Everframe setting', () => {
    const project = loadProject();
    patchXcodeProject(project, APP);
    expect(SYMBOLS_BUILD_SETTINGS).toEqual({ ENABLE_USER_SCRIPT_SANDBOXING: 'NO' });
    for (const s of appBuildSettings(project)) {
      expect(s.ENABLE_USER_SCRIPT_SANDBOXING).toBe('NO');
      expect(Object.keys(s).filter((key) => key.startsWith('EVERFRAME_'))).toEqual([]);
    }
  });

  it('writes the one-line script', () => {
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
  const lists = project.pbxXCConfigurationList() as Record<
    string,
    { buildConfigurations?: Array<{ value: string }> }
  >;
  const configs = project.pbxXCBuildConfigurationSection() as Record<
    string,
    { buildSettings?: Record<string, string> }
  >;
  return (lists[target.buildConfigurationList]?.buildConfigurations ?? []).map(
    (ref) => configs[ref.value]!.buildSettings!,
  );
}

describe('patchRootBuildGradle', () => {
  const ROOT =
    "buildscript {\n  dependencies {\n    classpath('com.android.tools.build:gradle')\n    classpath('com.facebook.react:react-native-gradle-plugin')\n  }\n}\n";
  it('adds the pinned Everframe Gradle plugin after the React Native plugin classpath, once', () => {
    const out = patchRootBuildGradle(ROOT);
    expect(out).toContain(`    classpath("${EVERFRAME_GRADLE_PLUGIN}")`);
    expect(out.indexOf('react-native-gradle-plugin')).toBeLessThan(
      out.indexOf('dev.everframe:gradle-plugin'),
    );
    expect(patchRootBuildGradle(out)).toBe(out);
  });
  it('pins the Gradle plugin of the current Android release', () => {
    const properties = readFileSync(
      join(__dirname, '../../sdk-android/android/gradle.properties'),
      'utf8',
    );
    const android = /^everframeVersion=(.+)$/m.exec(properties)![1]!.trim();
    expect(EVERFRAME_GRADLE_PLUGIN).toBe(`dev.everframe:gradle-plugin:${android}`);
  });
  it('compiles the Android release version in from gradle.properties', () => {
    const properties = readFileSync(
      join(__dirname, '../../sdk-android/android/gradle.properties'),
      'utf8',
    );
    expect(buildConstants().__EVERFRAME_ANDROID_VERSION__).toBe(
      JSON.stringify(androidVersionFrom(properties)),
    );
    expect(androidVersionFrom('android.useAndroidX=true\neverframeVersion=1.4.0\n')).toBe('1.4.0');
    expect(() => androidVersionFrom('android.useAndroidX=true\n')).toThrow(/everframeVersion/);
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
