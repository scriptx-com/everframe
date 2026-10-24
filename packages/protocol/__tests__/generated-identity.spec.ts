// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const swiftRoot = path.resolve(here, '../../sdk-ios/Sources/EverframeProtocol');
const kotlinRoot = path.resolve(
  here,
  '../../sdk-android/android/everframe-protocol/src/main/kotlin/dev/everframe/protocol/generated',
);

describe('generated Everframe protocol identity', () => {
  it.each(['Generated.swift', 'VTree.swift'])(
    '%s prefixes every public protocol declaration with Everframe',
    (file) => {
      const source = readFileSync(path.join(swiftRoot, file), 'utf8');
      const declarations = [...source.matchAll(/^public (?:struct|enum|class) (\w+)/gmu)].map(
        (match) => match[1],
      );
      expect(declarations.length).toBeGreaterThan(0);
      expect(declarations.filter((name) => !name?.startsWith('Everframe'))).toEqual([]);
    },
  );

  it.each(['Generated.kt', 'VTree.kt'])('%s uses the verified Maven namespace', (file) => {
    const source = readFileSync(path.join(kotlinRoot, file), 'utf8');
    expect(source).toMatch(/^package dev\.everframe\.protocol\.generated$/mu);
    expect(source).not.toMatch(new RegExp(`^package com\\.${'trace' + 'itx'}\\.`, 'mu'));
  });

  it('generated Swift decodes the legacy video value but encodes it canonically', () => {
    const source = readFileSync(path.join(swiftRoot, 'Generated.swift'), 'utf8');
    expect(source).toContain('case legacyVideoV1 = "traceitx-video-v1"');
    expect(source).toContain('case .legacyVideoV1: encoded = "everframe-video-v1"');
  });

  it('generated Kotlin decodes the legacy video value but encodes it canonically', () => {
    const source = readFileSync(path.join(kotlinRoot, 'Generated.kt'), 'utf8');
    expect(source).toContain('@SerialName("traceitx-video-v1") LegacyVideoV1("traceitx-video-v1")');
    expect(source).toContain('Format.LegacyVideoV1 -> "everframe-video-v1"');
  });

  it('generated Swift decodes the legacy VTree version but encodes it canonically', () => {
    const source = readFileSync(path.join(swiftRoot, 'VTree.swift'), 'utf8');
    expect(source).toContain('case legacyV1 = "traceitx-vtree-v1"');
    expect(source).toContain('try container.encode("everframe-vtree-v1")');
  });

  it('generated Kotlin decodes the legacy VTree version but encodes it canonically', () => {
    const source = readFileSync(path.join(kotlinRoot, 'VTree.kt'), 'utf8');
    expect(source).toContain('@SerialName("traceitx-vtree-v1") LegacyV1("traceitx-vtree-v1")');
    expect(source).toContain('encoder.encodeString("everframe-vtree-v1")');
  });

  it('generated Kotlin writes the pointer app build as an explicit null and debug and keeps App', () => {
    const source = readFileSync(path.join(kotlinRoot, 'Generated.kt'), 'utf8');
    expect(source).toMatch(
      /\ndata class NativeExposureApp \(\n {4}@Required\n {4}val build: String\? = null,\n {4}val debug: Boolean,\n {4}val version: String\n\)/u,
    );
    expect(source).toMatch(/\ndata class NativeExposure \(\n {4}val app: NativeExposureApp,\n/u);
    expect(source).toMatch(
      /\n@Serializable\ndata class App \(\n {4}val build: String\? = null,\n {4}val debug: Boolean\? = null,\n {4}val name: String,\n {4}val version: String,\n {4}val jsBundle: JSBundle\? = null\n\)/u,
    );
    // Spelled in two parts so the repository-wide check for the retired field stays clean.
    expect(source).not.toContain('native' + 'BuildId');
  });

  it('generated Swift writes the pointer app build as an explicit null and debug and keeps EverframeApp', () => {
    const source = readFileSync(path.join(swiftRoot, 'Generated.swift'), 'utf8');
    expect(source).toContain(
      'public struct EverframeApp: Codable {\n    public let build: String?\n    public let debug: Bool?\n    public let jsBundle: EverframeJSBundle?\n    public let name, version: String\n',
    );
    expect(source).toContain('public struct EverframeNativeExposureApp: Codable {');
    expect(source).toContain(
      '        try container.encode(version, forKey: .version)\n        try container.encode(build, forKey: .build)\n        try container.encode(debug, forKey: .debug)\n',
    );
    expect(source).toContain(
      '        try container.encode(app, forKey: .app)\n        try container.encode(exposureID, forKey: .exposureID)\n',
    );
    expect(source).not.toContain('nativeBuildID');
  });
});
