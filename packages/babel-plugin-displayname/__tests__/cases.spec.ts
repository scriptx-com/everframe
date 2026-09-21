// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, it, expect } from 'vitest';
import { transformAsync } from '@babel/core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const plugin = require('../src/index.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'fixtures', 'cases');

async function transform(file: string): Promise<string> {
  const source = readFileSync(path.join(CASES_DIR, file), 'utf8');
  const result = await transformAsync(source, {
    babelrc: false,
    configFile: false,
    presets: [['@babel/preset-typescript', { allExtensions: true, isTSX: true }], '@babel/preset-react'],
    plugins: [plugin],
    filename: file,
  });
  return result?.code ?? '';
}

describe('PAY-06: Babel plugin cases (per displayname-cases.md)', () => {
  it('forwardref: const Foo = forwardRef(...) → Foo.displayName = "Foo"', async () => {
    const out = await transform('forwardref.tsx');
    expect(out).toContain('Foo.displayName = "Foo"');
  });

  it('memo: const Bar = memo(...) → Bar.displayName = "Bar"', async () => {
    const out = await transform('memo.tsx');
    expect(out).toContain('Bar.displayName = "Bar"');
  });

  it('forwardref-memo: const Baz = memo(forwardRef(...)) → Baz.displayName = "Baz"', async () => {
    const out = await transform('forwardref-memo.tsx');
    expect(out).toContain('Baz.displayName = "Baz"');
  });

  it('function-decl: function Comp() {} → Comp.displayName = "Comp"', async () => {
    const out = await transform('function-decl.tsx');
    expect(out).toContain('Comp.displayName = "Comp"');
    // lowercase function should NOT be touched
    expect(out).not.toContain('helper.displayName');
  });

  it('already-set: user-explicit Pre.displayName="Custom" not duplicated', async () => {
    const out = await transform('already-set.tsx');
    expect(out).toContain("Pre.displayName = 'Custom'");
    // Plugin must NOT add `Pre.displayName = "Pre"` after the explicit set
    const occurrences = (out.match(/Pre\.displayName/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('plain-arrow returning null: const Plain = () => null → no insertion (no JSX in return)', async () => {
    const out = await transform('arrow-component.tsx');
    expect(out).not.toContain('Plain.displayName');
  });

  it('arrow-jsx: const Hello = () => <div/> → Hello.displayName = "Hello"', async () => {
    const out = await transform('arrow-component-jsx.tsx');
    expect(out).toContain('Hello.displayName = "Hello"');
  });

  it('arrow-block-jsx: const Card = (p) => { ...; return <section/> } → Card.displayName = "Card"', async () => {
    const out = await transform('arrow-component-block.tsx');
    expect(out).toContain('Card.displayName = "Card"');
  });

  it('arrow-conditional-jsx: const Badge = (p) => p.ok ? <a/> : <b/> → Badge.displayName = "Badge"', async () => {
    const out = await transform('arrow-component-conditional.tsx');
    expect(out).toContain('Badge.displayName = "Badge"');
  });

  it('function-expression: const Panel = function() { return <div/> } → Panel.displayName = "Panel"', async () => {
    const out = await transform('function-expression-component.tsx');
    expect(out).toContain('Panel.displayName = "Panel"');
  });

  it('arrow-non-component: PascalCase consts that do not return JSX must NOT be tagged', async () => {
    const out = await transform('arrow-non-component.tsx');
    expect(out).not.toContain('Reducer.displayName');
    expect(out).not.toContain('Status.displayName');
    // Factory's body has a nested arrow that returns JSX, but Factory itself returns the function.
    // The nested arrow is anonymous and lives inside Factory's scope — not a top-level decl.
    expect(out).not.toContain('Factory.displayName');
  });

  it('class-component: class Counter extends Component → static displayName = "Counter"', async () => {
    const out = await transform('class-component.tsx');
    expect(out).toMatch(/static\s+displayName\s*=\s*"Counter"/);
  });

  it('class-pure: class Pure extends PureComponent → static displayName = "Pure"', async () => {
    const out = await transform('class-component-pure.tsx');
    expect(out).toMatch(/static\s+displayName\s*=\s*"Pure"/);
  });

  it('class-react-ns: class Modal extends React.Component → static displayName = "Modal"', async () => {
    const out = await transform('class-component-react-ns.tsx');
    expect(out).toMatch(/static\s+displayName\s*=\s*"Modal"/);
  });

  it('class-already-set: explicit static displayName must not be duplicated', async () => {
    const out = await transform('class-already-set.tsx');
    expect(out).toContain("'CustomName'");
    const occurrences = (out.match(/displayName/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it('class-non-component: PascalCase classes not extending React base classes must NOT be tagged', async () => {
    const out = await transform('class-non-component.tsx');
    expect(out).not.toContain('Logger.displayName');
    expect(out).not.toContain('CacheLine.displayName');
    expect(out).not.toMatch(/static\s+displayName/);
  });
});
