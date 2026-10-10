// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('release-health native bridge contracts', () => {
  it('Android installs the optional known-bundle configuration in its equality-checked SDK config', () => {
    const android = source('android/src/main/java/dev/everframe/rn/EverframeModule.kt');
    expect(android).toContain('releaseHealth = parseReleaseHealth(opts)');
    expect(android).toContain('ReleaseHealthBundleStatus.KNOWN');
    expect(android).toContain('Everframe.currentConfig == config');
  });
  it('iOS reserves exact configure ownership synchronously before asynchronous health work', () => {
    const swift = source('ios/Sources/EverframeBridge.swift');
    expect(swift).toContain('configureLock.lock()');
    expect(swift).toContain('defer { configureLock.unlock() }');
    expect(swift).toContain('configureAndPrepareReleaseHealth(');
    expect(swift).toContain('forceRestart: companionAttachPinUi != newAttachPinUi');
    expect(swift).not.toContain('Everframe.shared.currentConfig == cfg');
    expect(swift).toMatch(/if let applyHealth[\s\S]*?Task \{ _ = await applyHealth\(\) \}/);
    expect(swift).not.toMatch(/Task\s*\{\s*(?:_ = )?await Everframe.shared.setReleaseHealth/);
  });
  it('forwards the release-health scalar fields through codegen', () => {
    // The pre-release-health Objective-C configure overload was removed (no customers yet).
    const objc = source('ios/Sources/EverframeModule.mm');
    for (const name of ['releaseHealthEnabled', 'releaseHealthNativeBuildId', 'releaseHealthLoadedBuildId', 'releaseHealthUserId']) {
      expect(objc).toContain(`opts.${name}()`);
      expect(objc).toContain(`${name}:`);
    }
  });
});
