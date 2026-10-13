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
  it('Android reads a missing enabled flag as on, only an explicit false as off, and forwards includeDebugBuilds', () => {
    const android = source('android/src/main/java/dev/everframe/rn/EverframeModule.kt');
    expect(android).toContain(
      'if (opts.takeIfHasBoolean("releaseHealthEnabled") == false) return null',
    );
    expect(android).not.toContain('opts.takeIfHasBoolean("releaseHealthEnabled") != true');
    expect(android).toContain('opts.takeIfHasBoolean("releaseHealthIncludeDebugBuilds") ?: false');
    expect(android).toContain('includeDebugBuilds = includeDebugBuilds');
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
  it('iOS builds health from the bridge fields alone, with includeDebugBuilds, and leaves the config default out', () => {
    const swift = source('ios/Sources/EverframeBridge.swift');
    expect(swift).toContain('releaseHealthIncludeDebugBuilds: Bool');
    expect(swift).toContain('includeDebugBuilds: releaseHealthIncludeDebugBuilds)');
    expect(swift).toContain('cfg.releaseHealth = nil');
  });
  it('forwards the release-health scalar fields through codegen', () => {
    // The pre-release-health Objective-C configure overload was removed (no customers yet).
    const objc = source('ios/Sources/EverframeModule.mm');
    for (const name of [
      'releaseHealthEnabled',
      'releaseHealthLoadedBuildId',
      'releaseHealthUserId',
      'releaseHealthIncludeDebugBuilds',
    ]) {
      expect(objc).toContain(`opts.${name}()`);
      expect(objc).toContain(`${name}:`);
    }
  });
  it('iOS module reads a missing enabled flag as on and a missing includeDebugBuilds as off', () => {
    const objc = source('ios/Sources/EverframeModule.mm');
    expect(objc).toContain('opts.releaseHealthEnabled().value_or(true)');
    expect(objc).not.toContain('opts.releaseHealthEnabled().value_or(false)');
    expect(objc).toContain('opts.releaseHealthIncludeDebugBuilds().value_or(false)');
  });
  it('carries debugBuild to both native configs, absent staying nil or null', () => {
    expect(source('android/src/main/java/dev/everframe/rn/EverframeModule.kt')).toContain(
      'debugBuild = opts.takeIfHasBoolean("debugBuild")',
    );
    expect(source('ios/Sources/EverframeBridge.swift')).toContain(
      'cfg.debugBuild = debugBuild?.boolValue',
    );
    const objc = source('ios/Sources/EverframeModule.mm');
    expect(objc).toContain('opts.debugBuild().has_value()');
    expect(objc).toContain('debugBuild:debugBuild');
    expect(source('src/NativeEverframe.ts')).toContain('debugBuild?: boolean;');
  });
  it('declares the includeDebugBuilds bridge field in the codegen spec', () => {
    expect(source('src/NativeEverframe.ts')).toContain(
      'releaseHealthIncludeDebugBuilds?: boolean;',
    );
  });
  it('passes no developer-typed native build ID across either bridge', () => {
    // The native SDKs read the app version; the bridges carry the flag, the loaded bundle and the user ID.
    for (const path of [
      'ios/Sources/EverframeModule.mm',
      'ios/Sources/EverframeBridge.swift',
      'src/NativeEverframe.ts',
      'src/runtime.ts',
      'android/src/main/java/dev/everframe/rn/EverframeModule.kt',
    ]) {
      expect(source(path), path).not.toContain('releaseHealthNativeBuildId');
    }
    expect(source('android/src/main/java/dev/everframe/rn/EverframeModule.kt')).toContain(
      'ReleaseHealthConfig(enabled = true, userId = user, loadedBuildId = loaded,',
    );
    expect(source('ios/Sources/EverframeBridge.swift')).toContain(
      'ReleaseHealthConfiguration(userId: releaseHealthUserId as String?,',
    );
  });
});
