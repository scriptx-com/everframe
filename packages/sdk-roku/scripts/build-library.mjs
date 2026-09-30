// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
//
// Zips library/ into dist/everframe-roku-<version>.zip — the one artifact used
// both bundled (pkg:/) and hosted (https://) as a Roku ComponentLibrary.
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.join(pkg, 'library');
const { version } = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8'));

const files = {};
(function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs);
    else files[path.relative(root, abs).split(path.sep).join('/')] = readFileSync(abs);
  }
})(root);

mkdirSync(path.join(pkg, 'dist'), { recursive: true });
const out = path.join(pkg, 'dist', `everframe-roku-${version}.zip`);
writeFileSync(out, zipSync(files, { level: 9, mtime: new Date('2026-01-01T00:00:00Z') }));
console.log(`[sdk-roku] wrote ${path.relative(pkg, out)}`);
