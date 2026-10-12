// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Everframe React Native bridge identity', () => {
  it('uses the canonical package, codegen, pod, and Android identities', () => {
    const manifest = JSON.parse(read('package.json'));
    const gradle = read('android/build.gradle.kts');
    const podspec = read('EverframeRN.podspec');

    expect(manifest.name).toBe('@everframe/react-native');
    expect(manifest.codegenConfig).toMatchObject({
      name: 'EverframeSpec',
      android: { javaPackageName: 'dev.everframe.rn' },
    });
    expect(gradle).toContain('namespace = "dev.everframe.rn"');
    expect(gradle).toContain('implementation("dev.everframe:core")');
    expect(gradle).toContain('implementation("dev.everframe:reporter-ui")');
    expect(podspec).toContain("s.name         = 'EverframeRN'");
    expect(podspec).toContain("s.dependency 'Everframe/Core', native_minor_range");
    expect(podspec).toContain("s.dependency 'Everframe/ReporterUI', native_minor_range");
  });

  // The ranges are literals, so a release that bumps package.json without them
  // ships a bridge that still resolves the previous native minor. The bridge
  // also calls EverframeConfig(sdkKey:), which first ships in native 1.2.0, so
  // the floor is never below 1.2 even while package.json is still 1.1.0.
  it('requires the native minor matching its own version, and at least 1.2', () => {
    const [ownMajor, ownMinor] = JSON.parse(read('package.json')).version.split('.').map(Number);
    const [major, minor] = ownMajor > 1 || (ownMajor === 1 && ownMinor >= 2) ? [ownMajor, ownMinor] : [1, 2];
    const floor = `${major}.${minor}.0`;
    const ceiling = `${major}.${minor + 1}.0`;

    expect(read('android/build.gradle.kts')).toContain(`nativeVersionOverride ?: "[${floor},${ceiling})"`);
    expect(read('EverframeRN.podspec')).toContain(`native_version_override.empty? ? '~> ${floor}'`);
  });

  it('exports only the canonical provider, hook, and screen names', () => {
    const index = read('src/index.ts');
    expect(index).toContain('EverframeProvider, useEverframe');
    expect(index).toContain('useEverframeScreen, EverframeScreen');
    expect(index).not.toContain('Trace' + 'ItX');
    expect(index).not.toMatch(/useTXScreen|\bTXScreen\b/);
  });
});
