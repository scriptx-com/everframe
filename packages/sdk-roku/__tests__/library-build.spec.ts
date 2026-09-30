// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { Parser } from 'brighterscript';
import { XMLParser } from 'fast-xml-parser';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(PKG, 'package.json'), 'utf8')).version;

describe('library zip', () => {
  let files: Record<string, Uint8Array>;
  beforeAll(() => {
    execFileSync(process.execPath, [path.join(PKG, 'scripts/build-library.mjs')], { cwd: PKG });
    files = unzipSync(readFileSync(path.join(PKG, `dist/everframe-roku-${version}.zip`)));
  });

  it('declares the Everframe component library in its manifest', () => {
    expect(strFromU8(files['manifest']!)).toMatch(/^sg_component_libs_provided=Everframe$/m);
  });

  it('contains both components and every lib file', () => {
    const libs = readdirSync(path.join(PKG, 'library/components/Everframe/lib'));
    for (const f of ['components/Everframe/Everframe.xml', 'components/Everframe/EverframeReporter.xml', ...libs.map((l) => `components/Everframe/lib/${l}`)]) {
      expect(files[f], f).toBeDefined();
    }
  });

  it('every .brs parses without diagnostics and every XML script uri exists in the zip', () => {
    const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
    for (const [name, bytes] of Object.entries(files)) {
      if (name.endsWith('.brs')) {
        expect(Parser.parse(strFromU8(bytes)).diagnostics, name).toEqual([]);
      }
      if (name.endsWith('.xml')) {
        const doc = xml.parse(strFromU8(bytes));
        const scripts = [doc.component.script].flat().filter(Boolean);
        for (const s of scripts) expect(files[s.uri.replace('pkg:/', '')], `${name} -> ${s.uri}`).toBeDefined();
      }
    }
  });
});
