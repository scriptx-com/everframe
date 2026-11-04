// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 ScriptX
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_API_URL, redact } from '../defaults.js';
import { createTicketClient, TicketApiError } from './client.js';
import { MAX_FILES, validateFiles } from './files.js';
import { parseTicketArg } from './ref.js';

export interface TicketDeps {
  env: NodeJS.ProcessEnv;
  out: (s: string) => void;
  err: (s: string) => void;
  client?: ReturnType<typeof createTicketClient>;
  newKey?: () => string;
}

const MISSING_TICKET_TOKEN =
  'missing_api_token: set EVERFRAME_API_TOKEN to a token with the tickets:write scope.';

const COMMON = {
  project: { type: 'string' },
  'idempotency-key': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const;

const OPTIONS = {
  create: {
    ...COMMON,
    title: { type: 'string' },
    description: { type: 'string' },
    'description-file': { type: 'string' },
    board: { type: 'string' },
    column: { type: 'string' },
    attach: { type: 'string', multiple: true },
  },
  attach: { ...COMMON },
  comment: {
    ...COMMON,
    body: { type: 'string' },
    'body-file': { type: 'string' },
    attach: { type: 'string', multiple: true },
  },
} as const;

export const TICKET_LINES = [
  '  everframe ticket create --title <text> [--description <text> | --description-file <path>] [--attach <image>...] [--project <uuid>] [--board <uuid>] [--column <uuid>] [--idempotency-key <key>] [--json]',
  '  everframe ticket attach <ticket> <image>... [--project <uuid>] [--idempotency-key <key>] [--json]',
  '  everframe ticket comment <ticket> (--body <text> | --body-file <path>) [--attach <image>...] [--project <uuid>] [--idempotency-key <key>] [--json]',
];

export const TICKET_USAGE = ['Usage:', ...TICKET_LINES].join('\n');

class BadInput extends Error {}

async function textFrom(inline: string | undefined, file: string | undefined, what: string) {
  if (inline !== undefined && file !== undefined)
    throw new BadInput(`pass only one of --${what} and --${what}-file`);
  if (file === undefined) return inline;
  try {
    return await readFile(file, 'utf8');
  } catch {
    throw new BadInput(`${file}: cannot be read`);
  }
}

/** `everframe ticket create | attach | comment`. Exit: 0 ok, 2 bad input, 1 API or network failure. */
export async function ticketCommand(argv: string[], deps: TicketDeps): Promise<number> {
  const { env } = deps;
  const sub = argv[0];
  if (sub === '--help' || sub === '-h') {
    deps.out(TICKET_USAGE);
    return 0;
  }
  if (sub !== 'create' && sub !== 'attach' && sub !== 'comment') {
    deps.err('everframe: ticket needs create, attach or comment');
    return 2;
  }
  // Redact at the sink: the token must never reach output, whatever produced the text.
  const out = (s: string) => deps.out(redact(s, env.EVERFRAME_API_TOKEN));
  const err = (s: string) => deps.err(redact(s, env.EVERFRAME_API_TOKEN));

  let values: Record<string, string | string[] | boolean | undefined>;
  const positionals: string[] = [];
  const attach: string[] = [];
  try {
    const parsed = parseArgs({
      args: argv.slice(1),
      strict: true,
      allowPositionals: true,
      tokens: true,
      options: OPTIONS[sub],
    });
    values = parsed.values as typeof values;
    // `--attach` takes every following positional until the next option, and may repeat.
    // Read the files from the tokens only: values.attach would count them twice.
    let inAttach = false;
    for (const t of parsed.tokens) {
      if (t.kind === 'option') {
        inAttach = (t.name as string) === 'attach';
        if (inAttach && t.value !== undefined) attach.push(t.value);
      } else if (t.kind === 'positional') {
        (inAttach ? attach : positionals).push(t.value);
      } else {
        inAttach = false;
      }
    }
  } catch {
    err(`everframe: ticket ${sub}: invalid arguments`);
    return 2;
  }
  if (values.help) {
    out(TICKET_USAGE);
    return 0;
  }
  const str = (k: string) => values[k] as string | undefined;

  try {
    let ref: { ticket: string; projectId?: string } | undefined;
    let filePaths = attach;
    const idempotencyKey = str('idempotency-key');
    if (
      idempotencyKey !== undefined &&
      (idempotencyKey.trim().length < 1 || idempotencyKey.trim().length > 255)
    )
      throw new BadInput('--idempotency-key must be 1 to 255 characters');
    if (sub === 'create') {
      if (positionals.length > 0) throw new BadInput('unexpected argument; use --attach for files');
    } else {
      const [arg, ...rest] = positionals;
      const parsed = arg === undefined ? null : parseTicketArg(arg);
      if (!parsed) throw new BadInput('give a ticket number, uuid or dashboard link');
      ref = parsed;
      if (sub === 'attach') {
        if (rest.length === 0) throw new BadInput('attach needs at least one file');
        filePaths = rest;
      } else if (rest.length > 0) {
        throw new BadInput('unexpected argument; use --attach for files');
      }
    }

    let description: string | undefined;
    let body: string | undefined;
    if (sub === 'create') {
      if (!str('title')?.trim()) throw new BadInput('--title is required');
      description = await textFrom(str('description'), str('description-file'), 'description');
    }
    if (sub === 'comment') {
      body = await textFrom(str('body'), str('body-file'), 'body');
      if (str('body') === undefined && str('body-file') === undefined)
        throw new BadInput('pass exactly one of --body and --body-file');
      if (!body?.trim()) throw new BadInput('the comment body is empty');
    }

    const checked = await validateFiles(filePaths, MAX_FILES);
    if (!checked.ok) throw new BadInput(checked.message);

    const token = env.EVERFRAME_API_TOKEN;
    if (!deps.client && !token) {
      err(`everframe: ${MISSING_TICKET_TOKEN}`);
      return 1;
    }
    let client: NonNullable<TicketDeps['client']>;
    try {
      client =
        deps.client ??
        createTicketClient({
          apiUrl: env.EVERFRAME_API_URL ?? DEFAULT_API_URL,
          token: token ?? '',
        });
    } catch {
      err(
        'everframe: invalid_api_url. https is required (http is allowed only for localhost). Check EVERFRAME_API_URL.',
      );
      return 1;
    }
    const projectId = str('project') ?? ref?.projectId ?? (env.EVERFRAME_PROJECT_ID || undefined);
    const key = idempotencyKey?.trim() ?? (deps.newKey ?? randomUUID)();

    let step: string = 'upload';
    let currentFile = '';
    try {
      const ids: string[] = [];
      for (const file of checked.files) {
        currentFile = file.name;
        ids.push((await client.upload(file, projectId)).id);
      }
      currentFile = '';
      let result: Record<string, unknown>;
      if (sub === 'create') {
        step = 'create';
        result = (await client.createTicket(
          {
            title: str('title'),
            ...(description !== undefined ? { description } : {}),
            ...(projectId ? { projectId } : {}),
            ...(str('board') ? { boardId: str('board') } : {}),
            ...(str('column') ? { columnId: str('column') } : {}),
            ...(ids.length ? { attachmentIds: ids } : {}),
          },
          key,
        )) as unknown as Record<string, unknown>;
      } else if (sub === 'attach') {
        step = 'attach';
        result = (await client.attach(
          (ref as { ticket: string }).ticket,
          ids,
          projectId,
          key,
        )) as unknown as Record<string, unknown>;
      } else {
        step = 'comment';
        result = (await client.comment(
          (ref as { ticket: string }).ticket,
          { body: body as string, ...(ids.length ? { attachmentIds: ids } : {}) },
          projectId,
          key,
        )) as unknown as Record<string, unknown>;
      }
      if (values.json) out(JSON.stringify(result));
      else out(typeof result.url === 'string' ? result.url : String(result.id ?? 'ok'));
      return 0;
    } catch (error) {
      const code = error instanceof TicketApiError ? error.code : 'network_error';
      const failed = error instanceof TicketApiError ? error.step : step;
      err(`everframe: ${failed} failed: ${code}${currentFile ? ` (${currentFile})` : ''}`);
      if (code === 'project_required')
        err(
          'pass --project, set EVERFRAME_PROJECT_ID, or paste a ticket link that contains the project id',
        );
      return 1;
    }
  } catch (error) {
    if (error instanceof BadInput) {
      err(`everframe: ticket ${sub}: ${error.message}`);
      return 2;
    }
    err(`everframe: ticket failed`);
    return 1;
  }
}
