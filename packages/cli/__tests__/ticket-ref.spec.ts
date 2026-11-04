// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { describe, expect, it } from 'vitest';
import { parseTicketArg } from '../src/tickets/ref.js';

const P = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
const B = '9d8c7b6a-1f2e-4d3c-8b7a-6f5e4d3c2b1a';
const U = '11111111-2222-4333-8444-555555555555';

describe('parseTicketArg', () => {
  it('accepts a number and a uuid', () => {
    expect(parseTicketArg('42')).toEqual({ ticket: '42' });
    expect(parseTicketArg(U)).toEqual({ ticket: U });
  });
  it('reads the project and card from a dashboard link', () => {
    const base = `https://everframe.dev/admin/projects/${P}/boards/${B}`;
    expect(parseTicketArg(`${base}?card=142`)).toEqual({ ticket: '142', projectId: P });
    expect(parseTicketArg(`${base}?card=${U}`)).toEqual({ ticket: U, projectId: P });
  });
  it('accepts slug links, setting a project only for a uuid project', () => {
    const at = (project: string, board: string) =>
      `https://everframe.dev/admin/projects/${project}/boards/${board}?card=142`;
    expect(parseTicketArg(at('my-app', 'bugs'))).toEqual({ ticket: '142' });
    expect(parseTicketArg(at(P, 'bugs'))).toEqual({ ticket: '142', projectId: P });
    expect(parseTicketArg(at('my-app', B))).toEqual({ ticket: '142' });
  });
  it('rejects anything else', () => {
    for (const bad of [
      '0',
      'abc',
      '-3',
      '1.5',
      '',
      `https://everframe.dev/admin/projects/${P}/boards/${B}`,
    ])
      expect(parseTicketArg(bad)).toBeNull();
    expect(parseTicketArg(`https://everframe.dev/admin/boards/${B}?card=1`)).toBeNull();
    expect(
      parseTicketArg(`https://everframe.dev/admin/projects/${P}/boards/${B}?card=x`),
    ).toBeNull();
  });
});
