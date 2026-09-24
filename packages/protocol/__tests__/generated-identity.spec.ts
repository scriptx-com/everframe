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
  it.each(['Generated.swift', 'Relay.swift', 'VTree.swift'])(
    '%s prefixes every public protocol declaration with Everframe',
    (file) => {
      const source = readFileSync(path.join(swiftRoot, file), 'utf8');
      const declarations = [...source.matchAll(/^public (?:struct|enum|class) (\w+)/gmu)]
        .map((match) => match[1]);
      expect(declarations.length).toBeGreaterThan(0);
      expect(declarations.filter((name) => !name?.startsWith('Everframe'))).toEqual([]);
    },
  );

  it.each(['Generated.kt', 'Relay.kt', 'VTree.kt'])(
    '%s uses the verified Maven namespace',
    (file) => {
      const source = readFileSync(path.join(kotlinRoot, file), 'utf8');
      expect(source).toMatch(/^package dev\.everframe\.protocol\.generated$/mu);
      expect(source).not.toMatch(new RegExp(`^package com\\.${'trace' + 'itx'}\\.`, 'mu'));
    },
  );

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
});
