// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('loads URL policy in a bare runtime without browser URL or text codecs', () => {
  // Load both our policy and its real parser in one fresh realm. Loading the
  // parser in Node first would conceal import-time browser-global dependencies.
  const context = createContext({});
  const require = createRequire(import.meta.url);
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  const load = (file: string): Record<string, unknown> => {
    const cached = modules.get(file);
    if (cached) return cached.exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        allowJs: true,
      },
    }).outputText;
    const dependency = (name: string) =>
      name === 'react-native'
        ? { NativeModules: {} }
        : load(require.resolve(name, { paths: [dirname(file)] }));
    runInContext(`(function(exports, require, module) {${code}\n})`, context, {
      filename: file,
    })(module.exports, dependency, module);
    return module.exports;
  };
  const { normalizeInteractionPolicy } = load(resolve('src/interactions/policy.ts')) as {
    normalizeInteractionPolicy(input: unknown): { urlRules: { origin: string }[] };
  };
  expect(
    normalizeInteractionPolicy({ urlRules: [{ origin: 'nocturne://title' }] }).urlRules,
  ).toEqual([{ origin: 'nocturne://title', queryKeys: [], routes: [], literalPaths: [] }]);
  expect(
    runInContext('typeof URL + ":" + typeof TextEncoder + ":" + typeof TextDecoder', context),
  ).toBe('undefined:undefined:undefined');
});
