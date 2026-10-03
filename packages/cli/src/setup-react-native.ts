// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import xcode from 'xcode';
import { assertGroovy, checkedAppId, patchAppBuildGradle, patchXcodeProject } from './native-setup/index.js';

const METRO_HINT = [
  "const { withEverframe } = require('@everframe/metro');",
  'module.exports = withEverframe(config);',
].join('\n');

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** One-time setup for bare React Native: same native steps the Expo plugin adds. */
export async function setupReactNative(options: {
  projectRoot: string;
  appId: string;
}): Promise<{ changed: string[]; metroHint: string }> {
  checkedAppId(options.appId);
  const changed: string[] = [];

  const gradlePath = join(options.projectRoot, 'android', 'app', 'build.gradle');
  if (!(await exists(gradlePath))) {
    if (await exists(`${gradlePath}.kts`)) assertGroovy('kotlin');
    throw new Error('no_android_build_gradle');
  }
  const gradle = await readFile(gradlePath, 'utf8');
  const patchedGradle = patchAppBuildGradle(gradle, options.appId);
  if (patchedGradle !== gradle) {
    await writeFile(gradlePath, patchedGradle);
    changed.push('android/app/build.gradle');
  }

  const iosDir = join(options.projectRoot, 'ios');
  const entries = await readdir(iosDir).catch(() => [] as string[]);
  const projects = entries.filter((name) => name.endsWith('.xcodeproj'));
  if (projects.length === 0) throw new Error('no_xcode_project');
  if (projects.length > 1) throw new Error('multiple_xcode_projects');
  const relative = `ios/${projects[0]}/project.pbxproj`;
  const pbxPath = join(options.projectRoot, relative);
  const before = await readFile(pbxPath, 'utf8');
  const project = xcode.project(pbxPath);
  project.parseSync();
  patchXcodeProject(project, options.appId);
  const after = project.writeSync();
  if (after !== before) {
    await writeFile(pbxPath, after);
    changed.push(relative);
  }
  return { changed, metroHint: METRO_HINT };
}
