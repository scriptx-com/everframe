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

/**
 * One-time setup for bare React Native: same native steps the Expo plugin adds.
 * Patches whichever of android/ and ios/ exist; everything is read and patched before any write.
 */
export async function setupReactNative(options: {
  projectRoot: string;
  appId: string;
}): Promise<{ changed: string[]; metroHint: string }> {
  checkedAppId(options.appId);
  const writes: Array<{ relative: string; before: string; after: string }> = [];

  const gradleRelative = 'android/app/build.gradle';
  const gradlePath = join(options.projectRoot, gradleRelative);
  if (await exists(gradlePath)) {
    const before = await readFile(gradlePath, 'utf8');
    writes.push({ relative: gradleRelative, before, after: patchAppBuildGradle(before, options.appId) });
  } else if (await exists(`${gradlePath}.kts`)) {
    assertGroovy('kotlin');
  }

  const entries = await readdir(join(options.projectRoot, 'ios')).catch(() => [] as string[]);
  const projects = entries.filter((name) => name.endsWith('.xcodeproj'));
  if (projects.length > 1) throw new Error('multiple_xcode_projects');
  if (projects.length === 1) {
    const relative = `ios/${projects[0]}/project.pbxproj`;
    const pbxPath = join(options.projectRoot, relative);
    const before = await readFile(pbxPath, 'utf8');
    const project = xcode.project(pbxPath);
    project.parseSync();
    patchXcodeProject(project, options.appId);
    writes.push({ relative, before, after: project.writeSync() });
  }

  if (writes.length === 0) throw new Error('no_native_project');
  const changed: string[] = [];
  for (const { relative, before, after } of writes) {
    if (after === before) continue;
    await writeFile(join(options.projectRoot, relative), after);
    changed.push(relative);
  }
  return { changed, metroHint: METRO_HINT };
}
