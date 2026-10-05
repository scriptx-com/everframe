// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StagedBuildPartial } from '@everframe/protocol';
import { identityModuleSource } from './identity.js';

export function stagingRoot(projectRoot: string): string {
  return join(projectRoot, '.everframe');
}

/** Writes the identity module and returns its path for use as a Metro polyfill. */
export function writeStagedIdentity(projectRoot: string, partial: StagedBuildPartial): string {
  const buildDirectory = join(stagingRoot(projectRoot), partial.buildId);
  mkdirSync(buildDirectory, { recursive: true });
  const identityPath = join(buildDirectory, 'identity.js');
  writeFileSync(
    join(buildDirectory, 'manifest.partial.json'),
    `${JSON.stringify(partial, null, 2)}\n`,
  );
  writeFileSync(identityPath, identityModuleSource(partial));
  writeFileSync(
    join(stagingRoot(projectRoot), `latest-${partial.platform}.json`),
    `${JSON.stringify({ buildId: partial.buildId }, null, 2)}\n`,
  );
  return identityPath;
}
