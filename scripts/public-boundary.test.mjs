// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('./public-boundary.mjs', import.meta.url));
const spdxLabel = `SPDX-${'License-Identifier:'}`;
const spdxDiagnostic = (file, license) => new RegExp(`${file}.*${spdxLabel} ${license}`);
const publicPackages = [
  '@everframe/babel-plugin-displayname',
  '@everframe/identity',
  '@everframe/protocol',
  '@everframe/react',
  '@everframe/react-native',
  '@everframe/sdk-android',
  '@everframe/sdk-core',
  '@everframe/sdk-ios-marker',
  '@everframe/swc-plugin-displayname',
  '@everframe/web',
];

const policy = {
  publicPackages,
  allowedTopLevel: ['.env.example', 'examples', 'package.json', 'packages'],
  requiredPaths: ['.env.example', 'packages/sdk-core/package.json'],
  forbiddenPathPatterns: [
    '(^|/)apps/',
    'examples/tvos-replay/scripts/(benchmark|companion|dashboard|drive-xctest|verify-recording)\\.mjs$',
  ],
  forbiddenTextPatterns: [
    { pattern: `@everframe/${'admin'}`, reason: 'out-of-scope package reference' },
  ],
  ignoredPathPatterns: [
    '(^|/)(?:node_modules|dist|build|target|\\.turbo|\\.next)(?:/|$)',
  ],
  envTemplates: ['.env.example'],
  license: {
    ownedExtensions: ['.mjs', '.ts'],
    upstream: [
      { path: 'packages/sdk-core/gradlew', spdx: 'Apache-2.0' },
    ],
  },
};

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), 'everframe-public-boundary-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  const policyPath = path.join(root, '.policy.json');
  writeFileSync(policyPath, JSON.stringify(policy));
  return { root, policyPath };
}

function run(files) {
  const { root, policyPath } = fixture(files);
  return spawnSync(process.execPath, [verifier, '--root', root, '--policy', policyPath], {
    encoding: 'utf8',
  });
}

const safeFiles = {
  '.env.example': 'EVERFRAME_KEY=\n',
  'package.json': JSON.stringify({ private: true }),
  'packages/sdk-core/package.json': JSON.stringify({
    name: '@everframe/sdk-core',
    dependencies: {},
  }),
  'packages/sdk-core/src/index.ts':
    `// ${spdxLabel} MIT\n// SPDX-FileCopyrightText: 2026 ScriptX\nexport const value = 1;\n`,
  'packages/sdk-core/gradlew':
    `#!/bin/sh\n# ${spdxLabel} Apache-2.0\n`,
};

test('accepts a public-only tree with empty environment placeholders', () => {
  const result = run(safeFiles);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('ignores generated build directories that cannot enter the source archive', () => {
  const result = run({
    ...safeFiles,
    '.turbo/cache/metadata.json': '{}',
    'packages/sdk-core/dist/generated.ts': 'export const generated = true;\n',
    'packages/sdk-core/build/generated.ts': 'export const generated = true;\n',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('rejects non-empty values in public environment templates', () => {
  const result = run({ ...safeFiles, '.env.example': 'EVERFRAME_KEY=not-empty\n' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /\.env\.example:1.*must be empty/);
});

test('rejects out-of-scope paths and package references', () => {
  const privatePackage = `@everframe/${'admin'}`;
  const result = run({
    ...safeFiles,
    [`apps/${'admin'}/index.ts`]: `// ${spdxLabel} MIT\n`,
    'packages/sdk-core/src/out-of-scope.ts':
      `// ${spdxLabel} MIT\nimport "${privatePackage}";\n`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /apps\/admin\/index\.ts.*forbidden path/);
  assert.match(result.stderr, /out-of-scope\.ts.*out-of-scope package reference/);
});

test('rejects unresolved internal workspace dependencies', () => {
  const files = structuredClone(safeFiles);
  files['packages/sdk-core/package.json'] = JSON.stringify({
    name: '@everframe/sdk-core',
    dependencies: { '@everframe/unlisted-api': 'workspace:*' },
  });
  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /@everframe\/unlisted-api.*not in publicPackages/);
});

test('accepts the exact Everframe public package set', () => {
  const files = structuredClone(safeFiles);
  for (const [index, packageName] of publicPackages.entries()) {
    const manifestPath = packageName === '@everframe/sdk-core'
      ? 'packages/sdk-core/package.json'
      : `packages/public-${index}/package.json`;
    files[manifestPath] = JSON.stringify({
      name: packageName,
      dependencies: {},
    });
  }

  const result = run(files);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

const legacyScope = `@${'trace' + 'itx'}`;

test('rejects legacy scoped packages', () => {
  const files = structuredClone(safeFiles);
  files['packages/legacy/package.json'] = JSON.stringify({
    name: `${legacyScope}/legacy`,
    dependencies: {},
  });

  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`${legacyScope}/legacy.*legacy package scope`));
});

test('rejects a legacy scoped root manifest', () => {
  const files = structuredClone(safeFiles);
  files['package.json'] = JSON.stringify({
    name: `${legacyScope}/root`,
    private: true,
  });

  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`package\\.json.*${legacyScope}/root.*legacy package scope`));
});

test('rejects a legacy scoped example manifest', () => {
  const files = structuredClone(safeFiles);
  files['examples/demo/package.json'] = JSON.stringify({
    name: `${legacyScope}/example-demo`,
    private: true,
  });

  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(`examples/demo/package\\.json.*${legacyScope}/example-demo.*legacy package scope`));
});

test('rejects a tree missing a required public package', () => {
  const files = structuredClone(safeFiles);
  delete files['packages/sdk-core/package.json'];
  const result = run(files);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /packages\/sdk-core\/package\.json.*required path is missing/);
});

test('rejects admin-backed tvOS automation', () => {
  const result = run({
    ...safeFiles,
    'examples/tvos-replay/scripts/benchmark.mjs':
      `// ${spdxLabel} MIT\nexport const benchmark = true;\n`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /examples\/tvos-replay\/scripts\/benchmark\.mjs.*forbidden path/);
});

test('rejects owned source without MIT SPDX while preserving upstream licenses', () => {
  const result = run({
    ...safeFiles,
    'packages/sdk-core/src/missing.ts': 'export const missing = true;\n',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, spdxDiagnostic('missing\\.ts', 'MIT'));
  assert.doesNotMatch(result.stderr, /gradlew/);
});

test('requires SPDX in the file header instead of a later string literal', () => {
  const result = run({
    ...safeFiles,
    'packages/sdk-core/src/late.ts':
      `export const embedded = "${spdxLabel} MIT";\n`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, spdxDiagnostic('late\\.ts', 'MIT'));
});

test('rejects relicensing an upstream Apache file as MIT', () => {
  const result = run({
    ...safeFiles,
    'packages/sdk-core/gradlew':
      `#!/bin/sh\n# ${spdxLabel} MIT\n`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, spdxDiagnostic('gradlew', 'Apache-2\\.0'));
});

test('diagnostics are path sorted and deterministic', () => {
  const files = {
    ...safeFiles,
    'packages/sdk-core/src/z.ts': 'export const z = 1;\n',
    'packages/sdk-core/src/a.ts': 'export const a = 1;\n',
  };
  const { root, policyPath } = fixture(files);
  const args = [verifier, '--root', root, '--policy', policyPath];
  const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
  const second = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(first.stderr, second.stderr);
  assert.ok(first.stderr.indexOf('/a.ts') < first.stderr.indexOf('/z.ts'));
});

test('the verifier has no undeclared runtime dependencies', () => {
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', verifier]));
});
