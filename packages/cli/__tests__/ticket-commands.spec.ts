// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TicketApiError } from '../src/tickets/client.js';
import { ticketCommand } from '../src/tickets/commands.js';

const TOKEN = 'efk_secret_token_value';
const P = '3f2b8c1e-5a4d-4e6f-9a1b-2c3d4e5f6a7b';
const B = '9d8c7b6a-1f2e-4d3c-8b7a-6f5e4d3c2b1a';
const dir = mkdtempSync(join(tmpdir(), 'ticket-cmd-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const png = join(dir, 'shot.png');
const png2 = join(dir, 'two.png');
writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(png2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));

const ticket = { id: 't1', url: 'https://everframe.dev/admin/projects/p/boards/b?card=1' };
let n: number;
let out: string[];
let err: string[];
let client: any;
beforeEach(() => {
  n = 0;
  out = [];
  err = [];
  client = {
    upload: vi.fn(async () => ({ id: `att-${++n}` })),
    createTicket: vi.fn(async () => ticket),
    attach: vi.fn(async () => ({ ...ticket, attachmentCount: 2 })),
    comment: vi.fn(async () => ({ id: 'c1', url: 'https://everframe.dev/c1' })),
  };
});
const run = (argv: string[], env: NodeJS.ProcessEnv = { EVERFRAME_API_TOKEN: TOKEN }) =>
  ticketCommand(argv, {
    env,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    client,
    newKey: () => 'key-1',
  });

describe('ticket create', () => {
  it('uploads every --attach file then creates once with all ids', async () => {
    const code = await run(['create', '--title', 'Bug', '--attach', png, '--attach', png2]);
    expect(code).toBe(0);
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(client.createTicket).toHaveBeenCalledTimes(1);
    expect(client.createTicket.mock.calls[0][0]).toMatchObject({
      title: 'Bug',
      attachmentIds: ['att-1', 'att-2'],
    });
    expect(client.createTicket.mock.calls[0][1]).toBe('key-1');
    expect(out).toEqual([ticket.url]);
  });
  it('an upload refusal creates no ticket and exits 1 naming the file', async () => {
    client.upload.mockRejectedValueOnce(new TicketApiError('upload', 415, 'unsupported_type'));
    const code = await run(['create', '--title', 'Bug', '--attach', png]);
    expect(code).toBe(1);
    expect(client.createTicket).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('upload failed: unsupported_type');
    expect(err.join('\n')).toContain('shot.png');
  });
  it('requires a title', async () => {
    expect(await run(['create'])).toBe(2);
    expect(client.upload).not.toHaveBeenCalled();
  });
  it('project precedence: flag, then env', async () => {
    await run(['create', '--title', 'x', '--project', P], {
      EVERFRAME_API_TOKEN: TOKEN,
      EVERFRAME_PROJECT_ID: 'env',
    });
    expect(client.createTicket.mock.calls[0][0].projectId).toBe(P);
    await run(['create', '--title', 'x'], {
      EVERFRAME_API_TOKEN: TOKEN,
      EVERFRAME_PROJECT_ID: 'env',
    });
    expect(client.createTicket.mock.calls[1][0].projectId).toBe('env');
  });
});

describe('ticket attach and comment', () => {
  it('attach accepts a dashboard link and passes its project', async () => {
    const link = `https://everframe.dev/admin/projects/${P}/boards/${B}?card=142`;
    expect(await run(['attach', link, png])).toBe(0);
    expect(client.attach).toHaveBeenCalledWith('142', ['att-1'], P, 'key-1');
    expect(client.upload.mock.calls[0][1]).toBe(P);
  });
  it('--project beats the link project', async () => {
    const link = `https://everframe.dev/admin/projects/${P}/boards/${B}?card=142`;
    const other = '11111111-2222-4333-8444-555555555555';
    await run(['attach', link, png, '--project', other]);
    expect(client.attach.mock.calls[0][2]).toBe(other);
  });
  it('comment requires exactly one of --body/--body-file', async () => {
    expect(await run(['comment', '7'])).toBe(2);
    const f = join(dir, 'b.txt');
    writeFileSync(f, 'from file');
    expect(await run(['comment', '7', '--body', 'x', '--body-file', f])).toBe(2);
    expect(client.comment).not.toHaveBeenCalled();
    expect(await run(['comment', '7', '--body-file', f, '--attach', png])).toBe(0);
    expect(client.comment).toHaveBeenCalledWith(
      '7',
      { body: 'from file', attachmentIds: ['att-1'] },
      undefined,
      'key-1',
    );
  });
  it('rejects an unparseable ticket with exit 2', async () => {
    expect(await run(['comment', 'abc', '--body', 'x'])).toBe(2);
    expect(client.comment).not.toHaveBeenCalled();
  });
});

describe('--attach forms', () => {
  it('create: several files after one flag, repeated flags, and --attach=', async () => {
    expect(await run(['create', '--title', 'x', '--attach', png, png2])).toBe(0);
    expect(client.createTicket.mock.calls[0][0].attachmentIds).toEqual(['att-1', 'att-2']);
    n = 0;
    expect(await run(['create', '--title', 'x', '--attach', png, png2, '--attach', png])).toBe(0);
    expect(client.createTicket.mock.calls[1][0].attachmentIds).toEqual(['att-1', 'att-2', 'att-3']);
    n = 0;
    expect(await run(['create', `--attach=${png}`, png2, '--title', 'x'])).toBe(0);
    expect(client.createTicket.mock.calls[2][0].attachmentIds).toEqual(['att-1', 'att-2']);
    expect(client.upload).toHaveBeenCalledTimes(7);
  });
  it('create: a stray positional exits 2 without a client call', async () => {
    expect(await run(['create', '--title', 'x', png])).toBe(2);
    expect(await run(['create', '--attach', png, '--title', 'x', png2])).toBe(2);
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.createTicket).not.toHaveBeenCalled();
  });
  it('comment: ticket first, then several files after one flag', async () => {
    expect(await run(['comment', '7', '--attach', png, png2, '--body', 'hi', '--json'])).toBe(0);
    expect(client.upload).toHaveBeenCalledTimes(2);
    expect(client.comment.mock.calls[0][1]).toEqual({
      body: 'hi',
      attachmentIds: ['att-1', 'att-2'],
    });
    expect(client.comment.mock.calls[0][0]).toBe('7');
  });
  it('comment: repeated flags and --attach= keep order', async () => {
    expect(
      await run(['comment', '7', `--attach=${png}`, png2, '--attach', png, '--body', 'hi']),
    ).toBe(0);
    expect(client.comment.mock.calls[0][1].attachmentIds).toEqual(['att-1', 'att-2', 'att-3']);
  });
  it('a ticket placed after --attach is read as a file and exits 2', async () => {
    expect(await run(['comment', '--attach', png, '7', '--body', 'hi'])).toBe(2);
    expect(client.upload).not.toHaveBeenCalled();
  });
});

describe('shared behaviour', () => {
  it('bad file -> exit 2 and no client call', async () => {
    expect(await run(['attach', '5', join(dir, 'missing.png')])).toBe(2);
    expect(client.upload).not.toHaveBeenCalled();
    expect(err.join('\n')).toContain('missing.png');
  });
  it('--idempotency-key is passed through', async () => {
    await run(['comment', '7', '--body', 'x', '--idempotency-key', 'mine']);
    expect(client.comment.mock.calls[0][3]).toBe('mine');
  });
  it('project_required prints the hint and exits 1', async () => {
    client.comment.mockRejectedValueOnce(new TicketApiError('comment', 400, 'project_required'));
    expect(await run(['comment', '7', '--body', 'x'])).toBe(1);
    const text = err.join('\n');
    expect(text).toContain('everframe: comment failed: project_required');
    expect(text).toContain(
      'pass --project, set EVERFRAME_PROJECT_ID, or paste a ticket link that contains the project id',
    );
  });
  it('--json prints the API response', async () => {
    await run(['create', '--title', 'x', '--json']);
    expect(JSON.parse(out[0] as string)).toEqual(ticket);
  });
  it('prints a fallback when the response lacks a url', async () => {
    client.createTicket.mockResolvedValueOnce({ id: 'only-id' });
    await run(['create', '--title', 'x']);
    expect(out).toEqual(['only-id']);
  });
  it('the token never appears in output', async () => {
    client.comment.mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    client.createTicket.mockResolvedValueOnce({ id: 'x', url: `https://h/${TOKEN}` });
    await run(['comment', '7', '--body', 'x']);
    await run(['create', '--title', 'x']);
    expect([...out, ...err].join('\n')).not.toContain(TOKEN);
  });
  it('missing token exits 1 without sending', async () => {
    const code = await ticketCommand(['comment', '7', '--body', 'x'], {
      env: {},
      out: (s) => out.push(s),
      err: (s) => err.push(s),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('tickets:write');
  });
  it('--help prints the ticket usage and exits 0', async () => {
    for (const argv of [
      ['--help'],
      ['-h'],
      ['create', '--help'],
      ['attach', '-h'],
      ['comment', '--help'],
    ]) {
      out = [];
      expect(await run(argv)).toBe(0);
      expect(out.join('\n')).toContain('everframe ticket create');
      expect(out.join('\n')).toContain('everframe ticket attach');
      expect(out.join('\n')).toContain('everframe ticket comment');
    }
    expect(client.upload).not.toHaveBeenCalled();
  });
  it('a TicketApiError carrying the token is redacted on the err sink', async () => {
    client.comment.mockRejectedValueOnce(new TicketApiError('comment', 400, `bad_${TOKEN}`));
    expect(await run(['comment', '7', '--body', 'x'])).toBe(1);
    expect(err.join('\n')).toContain('comment failed');
    expect(err.join('\n')).not.toContain(TOKEN);
  });
  it('a --json response containing the token is redacted on the out sink', async () => {
    client.createTicket.mockResolvedValueOnce({ id: 'x', echoed: TOKEN });
    expect(await run(['create', '--title', 'x', '--json'])).toBe(0);
    expect(out.join('\n')).toContain('"id":"x"');
    expect(out.join('\n')).not.toContain(TOKEN);
  });
});

describe('bad input exits 2 without a client call', () => {
  it('a --help value is not help', async () => {
    expect(await run(['comment', '7', '--body', '--help'])).toBe(2);
    expect(out).toEqual([]);
    none();
  });
  it('an invalid --idempotency-key, before any upload', async () => {
    for (const key of ['', '   ', 'k'.repeat(256)]) {
      expect(
        await run(['comment', '7', '--body', 'x', '--attach', png, '--idempotency-key', key]),
      ).toBe(2);
    }
    none();
    expect(await run(['comment', '7', '--body', 'x', '--idempotency-key', 'k'.repeat(255)])).toBe(
      0,
    );
  });
  const none = () => {
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.createTicket).not.toHaveBeenCalled();
    expect(client.attach).not.toHaveBeenCalled();
    expect(client.comment).not.toHaveBeenCalled();
  };
  it('create with both --description and --description-file', async () => {
    const f = join(dir, 'd.txt');
    writeFileSync(f, 'd');
    expect(
      await run(['create', '--title', 'x', '--description', 'a', '--description-file', f]),
    ).toBe(2);
    none();
  });
  it('attach with no files', async () => {
    expect(await run(['attach', '5'])).toBe(2);
    none();
  });
  it('comment with an extra positional', async () => {
    expect(await run(['comment', '7', png, '--body', 'x'])).toBe(2);
    none();
  });
  it('comment with neither or both --body/--body-file', async () => {
    const f = join(dir, 'b2.txt');
    writeFileSync(f, 'b');
    expect(await run(['comment', '7'])).toBe(2);
    expect(await run(['comment', '7', '--body', 'x', '--body-file', f])).toBe(2);
    none();
  });
  it('11 --attach files', async () => {
    const args = ['create', '--title', 'x'];
    for (let i = 0; i < 11; i++) args.push('--attach', png);
    expect(await run(args)).toBe(2);
    expect(err.join('\n')).toContain('11');
    none();
  });
});
