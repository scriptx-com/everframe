// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { access, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import xcode from "xcode";
import { patchXcodeProjectForSymbols, type XcodeSymbolsProject } from "./native-setup/index.js";

export async function setupXcode(options: {
  project: string;
  appId?: string;
  targets?: string[];
  cliVersion: string;
}): Promise<{ changed: boolean; targets: string[]; xcodegen: boolean }> {
  const projectDir = resolve(options.project);
  const pbxPath = join(projectDir, "project.pbxproj");
  const before = await readFile(pbxPath, "utf8");
  const project = xcode.project(pbxPath);
  project.parseSync();
  const targets = patchXcodeProjectForSymbols(project as XcodeSymbolsProject, options);
  const after: string = project.writeSync();
  if (after !== before) await writeFile(pbxPath, after);
  const xcodegen = await access(join(dirname(projectDir), "project.yml")).then(() => true, () => false);
  return { changed: after !== before, targets, xcodegen };
}
